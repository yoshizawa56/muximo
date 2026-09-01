import { PassThrough } from "node:stream";
import {
  encodeMuximodControlResponse,
  type MuximodControlRequest,
  type MuximodControlResponse,
} from "@muximo/contract/control";
import { AgentSession, AgentSessionId, WorkspaceId } from "@muximo/domain";
import {
  type CleanupRegistrar,
  type FixtureHandle,
  hasError,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { MuximodPairingControlAdapter } from "./muximod-pairing-control-adapter.js";

type AdapterStep =
  | { type: "prepare" }
  | { type: "prepare-response" }
  | { type: "attach" }
  | { type: "complete" }
  | { type: "timeout" }
  | { type: "close" };
type AdapterKey = "default" | "timeout";
type AdapterFixture = {
  adapter: MuximodPairingControlAdapter;
  transport: PassThrough;
  writes: MuximodControlRequest[];
  state: { closed: boolean };
  preparePromise?: Promise<unknown>;
  push(response: MuximodControlResponse): void;
};
type AdapterContext = {
  requestTypes: readonly MuximodControlRequest["type"][];
  closed: boolean;
};

const executionId = "execution-id-123456";
const session = AgentSession.create({
  id: AgentSessionId.create("agent-session-id"),
  name: "review",
  backend: "codex",
  status: "running",
  workspaceId: WorkspaceId.create("workspace-id"),
  workspaceRoot: "/workspace/review",
  workspaceName: "workspace",
  useWorktree: false,
  setupRan: false,
  resuming: false,
  executionId,
  executionStartedAt: "2026-08-30T00:00:00.000Z",
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
});

const cases = [
  {
    name: "prepares, attaches, and completes a host-owned execution",
    fixture: "default" as const,
    steps: [{ type: "prepare" }, { type: "prepare-response" }, { type: "attach" }, { type: "complete" }],
    assert: [
      hasObserved<AdapterContext, undefined>("requestTypes", [
        "prepare_agent_execution",
        "attach_agent_execution",
        "complete_agent_execution",
      ]),
      hasObserved<AdapterContext, undefined>("closed", false),
    ],
  },
  {
    name: "fails a pending control request when the socket closes without executing a process",
    fixture: "default" as const,
    steps: [{ type: "prepare" }, { type: "close" }],
    assert: [
      hasError<AdapterContext, undefined>({ code: "control_socket_closed" }),
      hasObserved<AdapterContext, undefined>("requestTypes", ["prepare_agent_execution"]),
      hasObserved<AdapterContext, undefined>("closed", true),
    ],
  },
  {
    name: "times out and closes a control request with no response",
    fixture: "timeout" as const,
    steps: [{ type: "prepare" }, { type: "timeout" }],
    assert: [
      hasError<AdapterContext, undefined>({ code: "control_request_timeout" }),
      hasObserved<AdapterContext, undefined>("requestTypes", ["prepare_agent_execution"]),
      hasObserved<AdapterContext, undefined>("closed", true),
    ],
  },
] satisfies readonly ScenarioCase<AdapterKey, AdapterStep, undefined, AdapterContext>[];

const table: ScenarioTable<AdapterFixture, AdapterKey, AdapterStep, undefined, AdapterContext> = {
  defaultFixture: createFixture,
  fixtures: {
    default: createFixture,
    timeout: (registerCleanup) => createFixture(registerCleanup, 1),
  },
  cases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "prepare") {
        fixture.preparePromise = fixture.adapter.prepareAgentExecution({
          operation: "run",
          input: {
            backend: "codex",
            hostPaneId: "%1",
            cwd: "/workspace/review",
            useWorktree: false,
            setupHookExplicit: false,
            cleanupHookExplicit: false,
            backendArgs: [],
          },
        });
        await waitForRequest(fixture, "prepare_agent_execution");
        continue;
      }
      if (step.type === "prepare-response") {
        const request = await waitForRequest(fixture, "prepare_agent_execution");
        fixture.push({
          type: "agent_execution_prepared",
          requestId: request.requestId,
          operation: "run",
          agentSessionId: session.id,
          executionId,
          hostPaneId: "%1",
          session,
          execution: {
            sessionId: session.id,
            executionId,
            sessionName: session.name,
            backend: "codex",
            command: ["codex"],
            cwd: "/workspace/review",
            environment: {},
          },
        });
        await fixture.preparePromise;
        continue;
      }
      if (step.type === "attach") {
        const attached = fixture.adapter.attachAgentExecution({
          agentSessionId: session.id,
          executionId,
          hostPaneId: "%1",
          executionPid: 456,
          executionStartedAt: "2026-08-30T00:00:01.000Z",
        });
        const request = await waitForRequest(fixture, "attach_agent_execution");
        fixture.push({
          type: "agent_execution_attached",
          requestId: request.requestId,
          agentSessionId: session.id,
          executionId,
          executionPid: 456,
          executionStartedAt: "2026-08-30T00:00:01.000Z",
        });
        await attached;
        continue;
      }
      if (step.type === "complete") {
        const completed = fixture.adapter.completeAgentExecution({
          operation: "run",
          agentSessionId: session.id,
          executionId,
          hostPaneId: "%1",
          result: { started: true, code: 0, interrupted: false, signal: null, pid: 456 },
        });
        const request = await waitForRequest(fixture, "complete_agent_execution");
        fixture.push({
          type: "agent_execution_completed",
          requestId: request.requestId,
          operation: "run",
          agentSessionId: session.id,
          executionId,
          process: { started: true, code: 0, interrupted: false, signal: null, pid: 456 },
          session,
          cleanup: { disposition: "not_requested", reason: "no_worktree" },
        });
        await completed;
        continue;
      }
      if (step.type === "timeout") {
        await fixture.preparePromise;
        continue;
      }
      fixture.transport.destroy();
      await fixture.preparePromise;
    }
    return undefined;
  },
  observe: (fixture) => ({
    requestTypes: fixture.writes.map((request) => request.type),
    closed: fixture.state.closed,
  }),
};

describe("muximod pairing control adapter", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

function createFixture(_registerCleanup?: CleanupRegistrar, requestTimeoutMs?: number): FixtureHandle<AdapterFixture> {
  const transport = new PassThrough();
  const writes: MuximodControlRequest[] = [];
  const state = { closed: false };
  transport.once("close", () => {
    state.closed = true;
  });
  const originalWrite = transport.write.bind(transport);
  transport.write = ((chunk: string | Uint8Array) => {
    writes.push(JSON.parse(chunk.toString()) as MuximodControlRequest);
    return true;
  }) as typeof transport.write;
  const Adapter = MuximodPairingControlAdapter as unknown as {
    new (socket: import("node:net").Socket, options?: { requestTimeoutMs?: number }): MuximodPairingControlAdapter;
  };
  const adapter = new Adapter(
    transport as unknown as import("node:net").Socket,
    requestTimeoutMs === undefined ? undefined : { requestTimeoutMs },
  );
  return {
    fixture: {
      adapter,
      transport,
      writes,
      state,
      push(response: MuximodControlResponse) {
        transport.push(`${encodeMuximodControlResponse(response)}\n`);
      },
    },
    cleanup: () => {
      adapter.close();
      transport.write = originalWrite;
    },
  };
}

async function waitForRequest<Kind extends MuximodControlRequest["type"]>(
  fixture: AdapterFixture,
  type: Kind,
): Promise<Extract<MuximodControlRequest, { type: Kind }>> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const request = fixture.writes.find((candidate) => candidate.type === type);
    if (request) return request as Extract<MuximodControlRequest, { type: Kind }>;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${type} request`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
