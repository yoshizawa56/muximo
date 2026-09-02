import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthService } from "@muximo/application";
import { AgentSession, AgentSessionId, WorkspaceId } from "@muximo/domain";
import {
  AuthStore,
  createAgentDatabase,
  createMigrationSchemaSynchronizer,
  MemoryAuthChallengeStore,
  MemoryAuthRateLimitStore,
  MemoryAuthWsTicketStore,
  nodeAuthCrypto,
} from "@muximo/infrastructure/runtime";
import {
  type CleanupRegistrar,
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { MuximodControlServer } from "./control.js";

type ControlRequest = { agentSessionId: string; hostPaneId: string; executionId: string };
type ControlStep =
  | { type: "adopt" | "observe" | "release" }
  | { type: "read-log"; lines: number }
  | { type: "prepare-execution" | "attach-execution" | "complete-execution" }
  | { type: "cancel-prepare" };
type ControlFixture = {
  server: MuximodControlServer;
  handleRequest: (line: string, signal?: AbortSignal) => void;
  connect: () => void;
  request: ControlRequest;
  responses: string[];
  calls: string[];
  applicationRequests: unknown[];
  observations: string[];
  logReads: number[];
  socket: ControlTestSocket;
  database: ReturnType<typeof createAgentDatabase>;
  prepareCancelled: boolean;
};
type ControlContext = {
  responses: readonly unknown[];
  requestIds: readonly string[];
  calls: readonly string[];
  applicationRequests: readonly unknown[];
  observations: readonly string[];
  logReads: readonly number[];
  prepareCancelled: boolean;
};

const request: ControlRequest = { agentSessionId: "session-id", hostPaneId: "%1", executionId: "execution-id-123456" };
const executionSession = AgentSession.create({
  id: AgentSessionId.create(request.agentSessionId),
  name: "review",
  backend: "codex",
  status: "running",
  workspaceId: WorkspaceId.create("workspace-id"),
  workspaceRoot: "/workspace/review",
  workspaceName: "workspace",
  useWorktree: false,
  setupRan: false,
  resuming: false,
  executionId: request.executionId,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
});
const execution = {
  sessionId: request.agentSessionId,
  executionId: request.executionId,
  sessionName: executionSession.name,
  backend: "codex" as const,
  command: ["codex"],
  cwd: "/workspace/review",
  environment: {},
};
const executionProcess = { started: true, code: 0, interrupted: false, signal: null, pid: 456 };
const executionStartedAt = "2026-08-30T00:00:01.000Z";

class ControlTestSocket extends EventEmitter {
  public destroyed = false;
  public writableEnded = false;
  public writableLength = 0;

  public constructor(private readonly onWrite: (data: string) => void) {
    super();
  }

  public setEncoding(_encoding: BufferEncoding): this {
    return this;
  }

  public write(data: string): boolean {
    if (this.destroyed) return false;
    this.onWrite(data);
    return true;
  }

  public destroy(_error?: Error): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writableEnded = true;
    this.emit("close");
    return this;
  }
}

const fixture = (
  _registerCleanup?: CleanupRegistrar,
  waitForPrepareCancellation = false,
): FixtureHandle<ControlFixture> => {
  const instanceDirectory = mkdtempSync(join(tmpdir(), "muximod-control-test-"));
  const database = createAgentDatabase(join(instanceDirectory, "muximod.sqlite"), {
    instanceDirectory,
    schemaSynchronizer: createMigrationSchemaSynchronizer(),
  });
  const store = new AuthStore(database.db, database.sqlite);
  const auth = new AuthService({
    store,
    serverId: store.serverId,
    crypto: nodeAuthCrypto,
    clock: { now: () => new Date("2099-08-15T00:00:00.000Z") },
    claimSink: { publish: () => undefined },
    challenges: new MemoryAuthChallengeStore(),
    rateLimits: new MemoryAuthRateLimitStore(),
    wsTickets: new MemoryAuthWsTicketStore(),
    connections: { disconnectDevice: async () => undefined, disconnectSession: async () => undefined },
  });
  const calls: string[] = [];
  const applicationRequests: unknown[] = [];
  const observations: string[] = [];
  const logReads: number[] = [];
  const responses: string[] = [];
  let prepareCancelled = false;
  const server = new MuximodControlServer({
    socketPath: "/tmp/muximod-control-test.sock",
    auth,
    readLog: async (lines) => {
      logReads.push(lines);
      return { state: "available", logFile: "/tmp/muximod.log", lines: ["first", "second"].slice(-lines) };
    },
    adoptAgentSession: async (input) => {
      applicationRequests.push({ operation: "adopt", ...input });
      calls.push(`adopt:${input.agentSessionId}:${input.hostPaneId}:${input.executionId}`);
    },
    observeAgentSession: async (input) => {
      applicationRequests.push({ operation: "observe", ...input });
      observations.push(
        `${input.agentSessionId}:${input.hostPaneId}:${input.executionId}:${input.state}:${input.recentOutput ?? ""}`,
      );
    },
    releaseAgentSession: async (input) => {
      applicationRequests.push({ operation: "release", ...input });
      calls.push(`release:${input.agentSessionId}:${input.hostPaneId}:${input.executionId}`);
    },
    prepareAgentExecution: async (input, signal) => {
      calls.push(`prepare:${input.operation}`);
      if (waitForPrepareCancellation) {
        await new Promise<void>((resolvePromise) => {
          if (signal.aborted) {
            prepareCancelled = true;
            resolvePromise();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              prepareCancelled = true;
              resolvePromise();
            },
            { once: true },
          );
        });
        throw new Error("muximod control request cancelled");
      }
      return {
        operation: input.operation,
        agentSessionId: executionSession.id,
        executionId: request.executionId,
        hostPaneId: input.input.hostPaneId,
        session: executionSession,
        execution,
      };
    },
    attachAgentExecution: async (input) => {
      calls.push(`attach:${input.agentSessionId}:${input.executionPid}:${input.executionStartedAt}`);
    },
    completeAgentExecution: async (input) => {
      calls.push(`complete:${input.operation}:${input.agentSessionId}:${input.result.code}`);
      return {
        operation: input.operation,
        agentSessionId: input.agentSessionId,
        executionId: input.executionId,
        process: input.result,
        session: executionSession,
        cleanup: { disposition: "not_requested" as const, reason: "no_worktree" as const },
      };
    },
  });
  const socket = new ControlTestSocket((data) => responses.push(data));
  const handleRequest = (
    server as unknown as {
      handleRequest: (client: typeof socket, line: string, signal?: AbortSignal) => Promise<void>;
    }
  ).handleRequest.bind(server);
  const handleConnection = (
    server as unknown as {
      handleConnection: (client: typeof socket) => void;
    }
  ).handleConnection.bind(server);
  return {
    fixture: {
      server,
      connect: () => handleConnection(socket),
      handleRequest: (line, signal) => {
        void handleRequest(socket, line, signal);
      },
      request,
      responses,
      calls,
      applicationRequests,
      observations,
      logReads,
      socket,
      database,
      get prepareCancelled() {
        return prepareCancelled;
      },
    },
    cleanup: async () => {
      await server.stop();
      database.close();
      rmSync(instanceDirectory, { recursive: true, force: true });
    },
  };
};

const cases = [
  {
    name: "dispatches pane adoption and release requests to the daemon",
    steps: [{ type: "adopt" }, { type: "observe" }, { type: "release" }],
    assert: [
      hasObserved<ControlContext, undefined>("responses", [
        { type: "agent_session_adopted", ...request },
        { type: "agent_session_observed", ...request, state: "waiting_input" },
        { type: "agent_session_released", ...request },
      ]),
      hasObserved<ControlContext, undefined>("requestIds", [
        "control-request-1",
        "control-request-2",
        "control-request-3",
      ]),
      hasObserved<ControlContext, undefined>("calls", [
        "adopt:session-id:%1:execution-id-123456",
        "release:session-id:%1:execution-id-123456",
      ]),
      hasObserved<ControlContext, undefined>("applicationRequests", [
        {
          operation: "adopt",
          agentSessionId: "session-id",
          hostPaneId: "%1",
          executionId: "execution-id-123456",
        },
        {
          operation: "observe",
          agentSessionId: "session-id",
          hostPaneId: "%1",
          executionId: "execution-id-123456",
          state: "waiting_input",
          recentOutput: "recent output",
        },
        {
          operation: "release",
          agentSessionId: "session-id",
          hostPaneId: "%1",
          executionId: "execution-id-123456",
        },
      ]),
      hasObserved<ControlContext, undefined>("observations", [
        "session-id:%1:execution-id-123456:waiting_input:recent output",
      ]),
    ],
  },
  {
    name: "returns daemon log data through the private control contract",
    steps: [{ type: "read-log", lines: 2 }],
    assert: [
      hasObserved<ControlContext, undefined>("responses", [
        { type: "daemon_log", state: "available", logFile: "/tmp/muximod.log", lines: ["first", "second"] },
      ]),
      hasObserved<ControlContext, undefined>("requestIds", ["control-request-1"]),
      hasObserved<ControlContext, undefined>("logReads", [2]),
    ],
  },
  {
    name: "dispatches host-owned execution lifecycle operations without a socket ownership lease",
    steps: [{ type: "prepare-execution" }, { type: "attach-execution" }, { type: "complete-execution" }],
    assert: [
      hasObserved<ControlContext, undefined>("responses", [
        {
          type: "agent_execution_prepared",
          operation: "run",
          agentSessionId: request.agentSessionId,
          executionId: request.executionId,
          hostPaneId: request.hostPaneId,
          session: executionSession,
          execution,
        },
        {
          type: "agent_execution_attached",
          agentSessionId: request.agentSessionId,
          executionId: request.executionId,
          executionPid: 456,
          executionStartedAt,
        },
        {
          type: "agent_execution_completed",
          operation: "run",
          agentSessionId: request.agentSessionId,
          executionId: request.executionId,
          process: executionProcess,
          session: executionSession,
          cleanup: { disposition: "not_requested", reason: "no_worktree" },
        },
      ]),
      hasObserved<ControlContext, undefined>("calls", [
        "prepare:run",
        `attach:${request.agentSessionId}:456:${executionStartedAt}`,
        `complete:run:${request.agentSessionId}:0`,
      ]),
    ],
  },
  {
    name: "forwards a disconnected execution preparation cancellation",
    fixture: "cancel" as const,
    steps: [{ type: "cancel-prepare" }],
    assert: [hasObserved<ControlContext, undefined>("prepareCancelled", true)],
  },
] satisfies readonly ScenarioCase<"cancel", ControlStep, undefined, ControlContext>[];

const table: ScenarioTable<ControlFixture, "cancel", ControlStep, undefined, ControlContext> = {
  defaultFixture: fixture,
  fixtures: { cancel: (registerCleanup) => fixture(registerCleanup, true) },
  cases,
  execute: async (testFixture, steps) => {
    for (const step of steps) {
      if (step.type === "cancel-prepare") {
        testFixture.connect();
        testFixture.socket.emit(
          "data",
          `${JSON.stringify({
            type: "prepare_agent_execution",
            requestId: `control-request-${testFixture.responses.length + 1}`,
            operation: "run",
            input: {
              backend: "codex",
              hostPaneId: request.hostPaneId,
              cwd: execution.cwd,
              useWorktree: false,
              setupHookExplicit: false,
              cleanupHookExplicit: false,
              backendArgs: [],
            },
          })}\n`,
        );
        await waitFor(() => testFixture.calls.includes("prepare:run"));
        testFixture.socket.destroy();
        await waitFor(() => testFixture.prepareCancelled);
        continue;
      }
      const type =
        step.type === "adopt"
          ? "adopt_agent_session"
          : step.type === "observe"
            ? "observe_agent_session"
            : step.type === "release"
              ? "release_agent_session"
              : step.type === "read-log"
                ? "read_log"
                : step.type === "prepare-execution"
                  ? "prepare_agent_execution"
                  : step.type === "attach-execution"
                    ? "attach_agent_execution"
                    : "complete_agent_execution";
      const expectedCount = testFixture.responses.length + 1;
      testFixture.handleRequest(
        JSON.stringify({
          type,
          requestId: `control-request-${expectedCount}`,
          ...(step.type === "read-log"
            ? { lines: step.lines }
            : step.type === "prepare-execution"
              ? {
                  operation: "run",
                  input: {
                    backend: "codex",
                    hostPaneId: request.hostPaneId,
                    cwd: execution.cwd,
                    useWorktree: false,
                    setupHookExplicit: false,
                    cleanupHookExplicit: false,
                    backendArgs: [],
                  },
                }
              : step.type === "attach-execution"
                ? { ...testFixture.request, executionPid: 456, executionStartedAt }
                : step.type === "complete-execution"
                  ? { ...testFixture.request, operation: "run", result: executionProcess }
                  : {
                      ...testFixture.request,
                      ...(step.type === "observe" ? { state: "waiting_input", recentOutput: "recent output" } : {}),
                    }),
        }),
      );
      await waitFor(() => testFixture.responses.length === expectedCount);
    }
  },
  observe: (testFixture) => ({
    responses: testFixture.responses.map((value) => {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      delete parsed.requestId;
      return parsed;
    }),
    requestIds: testFixture.responses.map((value) => (JSON.parse(value) as { requestId?: string }).requestId ?? ""),
    calls: [...testFixture.calls],
    applicationRequests: [...testFixture.applicationRequests],
    observations: [...testFixture.observations],
    logReads: [...testFixture.logReads],
    prepareCancelled: testFixture.prepareCancelled,
  }),
};

describe("muximod private control socket", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for muximod control response");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
