import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionRepository } from "@muximo/application";
import { AgentSession, AgentSessionId, type AgentSessionRecord, WorkspaceId } from "@muximo/domain";
import {
  AgentBackendAdapter,
  AgentPluginRegistry,
  type AgentPluginV1,
  createDefaultAgentBackendProviders,
} from "@muximo/infrastructure";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import type { CodexSessionStateRepository } from "../agents/codex/state.js";

type BackendFixture = {
  root: string;
  executable: string;
  log: string;
  observations: Array<{ state: string; recentOutput?: string }>;
  disposeCount: number;
  prepareInput?: { name?: string; cwd: string; resumeSessionId?: string | null };
  runCount: number;
  sessionUpdate?: string;
  sameProcessResult?: boolean;
  adapter: AgentBackendAdapter;
  session: AgentSessionRecord;
};

type BackendResult = {
  runCount: number;
  disposeCount: number;
  observations: readonly { state: string; recentOutput?: string }[];
  sessionUpdate: string | undefined;
  sameProcessResult: boolean;
  preparedCwd: string | undefined;
};

type Input = {};

const cases = [
  {
    name: "returns provider session metadata and executes a launch plan once",
    input: {},
    assert: [
      hasObserved<BackendResult, BackendResult>("sessionUpdate", "provider-session"),
      hasObserved<BackendResult, BackendResult>("runCount", 1),
      hasObserved<BackendResult, BackendResult>("disposeCount", 1),
      hasObserved<BackendResult, BackendResult>("observations", [
        { state: "waiting_input", recentOutput: "Need input" },
      ]),
      hasObserved<BackendResult, BackendResult>("sameProcessResult", true),
      {
        name: "passes the session working directory to the provider",
        check: (context: BackendResult) => expect(context.preparedCwd).toContain("backend-adapter-"),
      },
    ],
  },
] satisfies readonly OperationCase<"default", Input, BackendResult, BackendResult>[];

const table: OperationTable<BackendFixture, "default", Input, BackendResult, BackendResult> = {
  defaultFixture: createBackendFixture,
  cases,
  execute: async (fixture) => {
    const preparation = await fixture.adapter.prepareLaunch(fixture.session, ["--opaque"], false);
    const backendSessionId = preparation.sessionUpdate?.backendSessionId;
    fixture.sessionUpdate = typeof backendSessionId === "string" ? backendSessionId : undefined;
    const first = await preparation.plan.run();
    const second = await preparation.plan.run();
    fixture.sameProcessResult = first === second;
    await preparation.plan.dispose();
    await preparation.plan.dispose();
    fixture.runCount = readInvocationCount(fixture.log);
    return {
      runCount: fixture.runCount,
      disposeCount: fixture.disposeCount,
      observations: fixture.observations,
      sessionUpdate: fixture.sessionUpdate,
      sameProcessResult: fixture.sameProcessResult,
      preparedCwd: fixture.prepareInput?.cwd,
    };
  },
  observe: (fixture) => ({
    runCount: fixture.runCount,
    disposeCount: fixture.disposeCount,
    observations: fixture.observations,
    sessionUpdate: fixture.sessionUpdate,
    sameProcessResult: fixture.sameProcessResult ?? false,
    preparedCwd: fixture.prepareInput?.cwd,
  }),
};

function createBackendFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: BackendFixture } {
  const root = mkdtempSync(join(tmpdir(), "muximo-backend-adapter-"));
  const executable = join(root, "provider");
  const log = join(root, "provider.log");
  writeFileSync(executable, "#!/bin/sh\nprintf 'run\\n' >>\"$MUXIMO_BACKEND_TEST_LOG\"\nexit 0\n", { mode: 0o700 });
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
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
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
    disposeCount,
    runCount: 0,
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
    ),
  );
  const adapterOptions = {
    environment,
    plugins: pluginRegistry,
    sessions: emptySessionRepository(),
    audit: { record: async () => undefined },
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      child: () => ({ debug: () => undefined, info: () => undefined, warn: () => undefined }),
    },
    observations: {
      observe: async (_session: AgentSessionRecord, observation: { state: string; recentOutput?: string }) => {
        fixture.observations.push(observation);
      },
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
    find: async () => undefined,
    save: async () => undefined,
    delete: async () => undefined,
  };
}

function createPlugin(
  executable: string,
  onPrepare: (input: { name?: string; cwd: string; resumeSessionId?: string | null }) => void,
  onDispose: () => void,
): AgentPluginV1 {
  return {
    manifest: { id: "opencode", version: "test", displayName: "Test OpenCode", capabilities: ["input"] },
    detect: async () => null,
    launch: async (input) => ({ command: executable, args: input.args ?? [], cwd: input.cwd, environment: {} }),
    createObserver: () => ({ onOutput: () => [], onExit: () => [] }),
    createMonitor: () => ({
      start: async (sink) => {
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

function emptySessionRepository(): AgentSessionRepository {
  return {
    findById: async () => undefined,
    findByName: async () => undefined,
    list: async () => [],
    insert: async () => undefined,
    update: async () => undefined,
    claimExecution: async () => false,
    setBackendSessionIdIfMissing: async () => false,
    delete: async () => undefined,
  };
}

function readInvocationCount(path: string): number {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

describe("agent backend CLI adapter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
