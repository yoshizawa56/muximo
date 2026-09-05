import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRepository } from "@muximo/application";
import { AgentSession, AgentSessionId, WorkspaceId } from "@muximo/domain";
import {
  AgentBackendAdapter,
  AgentPluginRegistry,
  type AgentPluginV1,
  createDefaultAgentBackendProviders,
} from "@muximo/infrastructure/runtime";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  resolveMaybePromise,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { CodexSessionStateRepository } from "../agents/codex/state.js";
import { spawnAttached } from "../process/process.js";

type BackendFixture = {
  root: string;
  executable: string;
  log: string;
  observations: Array<{ state: string; recentOutput?: string }>;
  monitorStarts: number;
  disposeCount: number;
  prepareInput?: { name?: string; cwd: string; resumeSessionId?: string | null };
  runCount: number;
  sessionUpdate?: string;
  processKeys: string[];
  failureDiagnostic?: string;
  processCode?: number;
  restoreAfterRestart: boolean;
  concurrentStart: boolean;
  adapter: AgentBackendAdapter;
  session: AgentSession;
};

type BackendResult = {
  runCount: number;
  disposeCount: number;
  observations: readonly { state: string; recentOutput?: string }[];
  sessionUpdate: string | undefined;
  processKeys: readonly string[];
  preparedCwd: string | undefined;
  processCode: number;
  failureDiagnostic: string | undefined;
  restoreAfterRestart: boolean;
  monitorStarts: number;
};

type FixtureKey = "success" | "failure" | "restore" | "concurrent";
type Input = {};

const cases = [
  {
    name: "returns provider session metadata and executes a successful launch plan once",
    fixture: "success" as const,
    input: {},
    assert: [
      hasObserved<BackendResult, BackendResult>("sessionUpdate", "provider-session"),
      hasObserved<BackendResult, BackendResult>("runCount", 1),
      hasObserved<BackendResult, BackendResult>("disposeCount", 1),
      hasObserved<BackendResult, BackendResult>("observations", [
        { state: "waiting_input", recentOutput: "Need input" },
      ]),
      hasObserved<BackendResult, BackendResult>("processKeys", ["started", "code", "interrupted", "pid", "signal"]),
      hasObserved<BackendResult, BackendResult>("processCode", 0),
      hasObserved<BackendResult, BackendResult>("failureDiagnostic", undefined),
      hasObserved<BackendResult, BackendResult>("monitorStarts", 1),
      {
        name: "passes the session working directory to the provider",
        check: (context: BackendResult) => expect(context.preparedCwd).toContain("backend-adapter-"),
      },
    ],
  },
  {
    name: "returns a sanitized diagnostic from a failed backend process",
    fixture: "failure" as const,
    input: {},
    assert: [
      hasObserved<BackendResult, BackendResult>("processCode", 1),
      hasObserved<BackendResult, BackendResult>("failureDiagnostic", "backend failed: stdin is not a terminal"),
      hasObserved<BackendResult, BackendResult>("monitorStarts", 1),
      hasObserved<BackendResult, BackendResult>("processKeys", [
        "started",
        "code",
        "interrupted",
        "pid",
        "signal",
        "failureDiagnostic",
      ]),
    ],
  },
  {
    name: "rebuilds provider observation after daemon-side launch state is lost",
    fixture: "restore" as const,
    input: {},
    assert: [
      hasObserved<BackendResult, BackendResult>("restoreAfterRestart", true),
      hasObserved<BackendResult, BackendResult>("runCount", 1),
      hasObserved<BackendResult, BackendResult>("disposeCount", 1),
      hasObserved<BackendResult, BackendResult>("observations", [
        { state: "waiting_input", recentOutput: "Need input" },
      ]),
    ],
  },
  {
    name: "coalesces concurrent monitor starts for one execution",
    fixture: "concurrent" as const,
    input: {},
    assert: [
      hasObserved<BackendResult, BackendResult>("monitorStarts", 1),
      hasObserved<BackendResult, BackendResult>("runCount", 1),
      hasObserved<BackendResult, BackendResult>("disposeCount", 1),
    ],
  },
] satisfies readonly OperationCase<FixtureKey, Input, BackendResult, BackendResult>[];

const table: OperationTable<BackendFixture, FixtureKey, Input, BackendResult, BackendResult> = {
  defaultFixture: (registerCleanup) => createBackendFixture("success", registerCleanup),
  fixtures: {
    success: (registerCleanup) => createBackendFixture("success", registerCleanup),
    failure: (registerCleanup) => createBackendFixture("failure", registerCleanup),
    restore: (registerCleanup) => createBackendFixture("restore", registerCleanup),
    concurrent: (registerCleanup) => createBackendFixture("concurrent", registerCleanup),
  },
  cases,
  execute: async (fixture) => {
    const preparation = await resolveMaybePromise(fixture.adapter.prepareLaunch(fixture.session, ["--opaque"], false));
    const backendSessionId = preparation.sessionUpdate?.backendSessionId;
    fixture.sessionUpdate = typeof backendSessionId === "string" ? backendSessionId : undefined;
    if (!fixture.restoreAfterRestart) {
      if (fixture.concurrentStart) {
        await resolveMaybePromise(
          Effect.all([fixture.adapter.startLaunch(fixture.session), fixture.adapter.startLaunch(fixture.session)]),
        );
      } else await resolveMaybePromise(fixture.adapter.startLaunch(fixture.session));
    } else {
      await resolveMaybePromise(fixture.adapter.close());
      fixture.session = fixture.session.update({
        backendSessionId: "provider-session",
        executionPid: process.pid,
        executionStartedAt: new Date(Date.now() - 1_000).toISOString(),
      });
      await resolveMaybePromise(fixture.adapter.restoreActiveLaunches());
    }
    const executable = preparation.execution.command[0];
    if (!executable) throw new Error("test command executable is missing");
    const first = await spawnAttached(
      executable,
      [...preparation.execution.command.slice(1)],
      preparation.execution.cwd,
      preparation.execution.environment,
      { captureFailureDiagnostic: true },
    );
    await resolveMaybePromise(fixture.adapter.completeLaunch(fixture.session, first));
    fixture.processKeys = Object.keys(first);
    fixture.runCount = readInvocationCount(fixture.log);
    fixture.processCode = first.code;
    fixture.failureDiagnostic = first.failureDiagnostic;
    return {
      runCount: fixture.runCount,
      disposeCount: fixture.disposeCount,
      observations: fixture.observations,
      sessionUpdate: fixture.sessionUpdate,
      processKeys: fixture.processKeys,
      preparedCwd: fixture.prepareInput?.cwd,
      processCode: fixture.processCode,
      failureDiagnostic: fixture.failureDiagnostic,
      restoreAfterRestart: fixture.restoreAfterRestart,
      monitorStarts: fixture.monitorStarts,
    };
  },
  observe: (fixture) => ({
    runCount: fixture.runCount,
    disposeCount: fixture.disposeCount,
    observations: fixture.observations,
    sessionUpdate: fixture.sessionUpdate,
    processKeys: fixture.processKeys,
    preparedCwd: fixture.prepareInput?.cwd,
    processCode: fixture.processCode ?? -1,
    failureDiagnostic: fixture.failureDiagnostic,
    restoreAfterRestart: fixture.restoreAfterRestart,
    monitorStarts: fixture.monitorStarts,
  }),
};

function createBackendFixture(
  key: FixtureKey,
  registerCleanup?: (cleanup: () => void) => void,
): { fixture: BackendFixture } {
  const root = mkdtempSync(join(tmpdir(), "muximo-backend-adapter-"));
  const executable = join(root, "provider");
  const log = join(root, "provider.log");
  const script =
    key === "failure"
      ? "#!/bin/sh\nprintf 'backend failed: stdin is not a terminal\\n' >&2\nprintf 'run\\n' >>\"$MUXIMO_BACKEND_TEST_LOG\"\nexit 1\n"
      : "#!/bin/sh\nprintf 'run\\n' >>\"$MUXIMO_BACKEND_TEST_LOG\"\nexit 0\n";
  writeFileSync(executable, script, { mode: 0o700 });
  chmodSync(executable, 0o700);
  const session = AgentSession.create({
    id: AgentSessionId.create("agent-session-id"),
    name: "review",
    backend: "opencode",
    status: "running",
    workspaceId: WorkspaceId.create("workspace-id"),
    workspaceRoot: root,
    workspaceName: "workspace",
    useWorktree: false,
    setupRan: false,
    resuming: false,
    executionId: "execution-id",
    lastActivityAt: "2026-08-23T00:00:00.000Z",
  });
  const disposeCount = 0;
  const environment = {
    ...process.env,
    MUXIMO_SET_TERMINAL_TITLE: "0",
    MUXIMO_BACKEND_TEST_LOG: log,
  };
  const fixture: BackendFixture = {
    root,
    executable,
    log,
    observations: [],
    monitorStarts: 0,
    disposeCount,
    runCount: 0,
    processKeys: [],
    restoreAfterRestart: key === "restore",
    concurrentStart: key === "concurrent",
    adapter: undefined as unknown as AgentBackendAdapter,
    session,
  };
  const pluginRegistry = new AgentPluginRegistry();
  pluginRegistry.register(
    createPlugin(
      executable,
      (input) => {
        fixture.prepareInput = { name: input.name, cwd: input.cwd, resumeSessionId: input.resumeSessionId };
      },
      () => {
        fixture.disposeCount += 1;
      },
      () => {
        fixture.monitorStarts += 1;
      },
    ),
  );
  const adapterOptions = {
    environment,
    plugins: pluginRegistry,
    sessions: emptySessionRepository(() => [fixture.session]),
    audit: { record: () => Effect.succeed(undefined) },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      child: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined }),
    },
    observations: {
      observe: (_session: AgentSession, observation: { state: string; recentOutput?: string }) =>
        Effect.sync(() => {
          fixture.observations.push(observation);
        }),
    },
  };
  fixture.adapter = new AgentBackendAdapter({
    ...adapterOptions,
    providers: createDefaultAgentBackendProviders(adapterOptions, emptyCodexStateRepository(), "unix://"),
  });
  fixture.disposeCount = disposeCount;
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  if (registerCleanup) registerCleanup(cleanup);
  return { fixture };
}

function emptyCodexStateRepository(): CodexSessionStateRepository {
  return {
    find: () => Effect.succeed(undefined),
    save: () => Effect.succeed(undefined),
    delete: () => Effect.succeed(undefined),
  };
}

function createPlugin(
  executable: string,
  onPrepare: (input: { name?: string; cwd: string; resumeSessionId?: string | null }) => void,
  onDispose: () => void,
  onStart: () => void,
): AgentPluginV1 {
  return {
    manifest: { id: "opencode", version: "test", displayName: "Test OpenCode", capabilities: ["input"] },
    detect: async () => null,
    launch: async (input) => ({ command: executable, args: input.args ?? [], cwd: input.cwd, environment: {} }),
    createObserver: () => ({ onOutput: () => [], onExit: () => [] }),
    createMonitor: () => ({
      start: async (sink) => {
        onStart();
        await sink({ type: "state_changed", state: "waiting_input", recentOutput: "Need input" });
      },
      stop: async () => undefined,
    }),
    prepareLaunch: async (input) => {
      onPrepare(input);
      return {
        primary: { command: executable, args: ["--opaque"], cwd: input.cwd, environment: {} },
        backendSessionId: "provider-session",
        dispose: async () => onDispose(),
      };
    },
    actions: () => [],
  };
}

function emptySessionRepository(listSessions: () => readonly AgentSession[] = () => []): AgentSessionRepository {
  return {
    findById: () => Effect.succeed(undefined),
    findByName: () => Effect.succeed(undefined),
    list: () => Effect.succeed([...listSessions()]),
    insert: () => Effect.succeed(undefined),
    update: () => Effect.succeed(undefined),
    claimExecution: () => Effect.succeed(false),
    claimAbandonedExecution: () => Effect.succeed(false),
    attachExecution: () => Effect.succeed(false),
    setBackendSessionIdIfMissing: () => Effect.succeed(false),
    delete: () => Effect.succeed(undefined),
  };
}

function readInvocationCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

describe("agent backend CLI adapter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
