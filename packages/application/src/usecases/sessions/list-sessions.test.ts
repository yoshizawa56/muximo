import type { Pane } from "@muximo/domain";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect, Layer } from "effect";
import { describe, it } from "vitest";
import type { ApplicationClock } from "../../effect-runtime.js";
import { applicationClockLayer } from "../../effect-runtime.js";
import type { MuximodSessionSummary } from "../../ports/application.js";
import type { HostPaneSnapshot, TerminalHostSnapshot } from "../../ports/host.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";
import type {
  AgentSessionRepository,
  MuximodHost,
  MuximodSessionManagement,
  MuximodViewport,
  PaneRepository,
} from "../terminals/terminal-services.js";
import { terminalLayer } from "../terminals/terminal-services.js";
import { listSessions } from "./list-sessions.js";

type Input = { managed: boolean };

type ListFixture = {
  host: MuximodHost;
  paneRepository: PaneRepository;
  agentSessionRepository: AgentSessionRepository;
  agentStatus: AgentStatusStore;
  result: MuximodSessionSummary[];
};

type ListContext = {
  managed: readonly boolean[];
};

const listCases = [
  {
    name: "reports a muximod-marked tmux session as managed",
    input: { managed: true },
    assert: [
      returns<ListContext, MuximodSessionSummary[]>([
        { name: "muximod", paneCount: 1, waitingCount: 0, detail: "0 agents · 1 shell", managed: true },
      ]),
      hasObserved<ListContext, MuximodSessionSummary[]>("managed", [true]),
    ],
  },
  {
    name: "reports a regular tmux session as unmanaged",
    input: { managed: false },
    assert: [
      returns<ListContext, MuximodSessionSummary[]>([
        { name: "desktop", paneCount: 1, waitingCount: 0, detail: "0 agents · 1 shell", managed: false },
      ]),
      hasObserved<ListContext, MuximodSessionSummary[]>("managed", [false]),
    ],
  },
] satisfies readonly OperationCase<"default", Input, MuximodSessionSummary[], ListContext>[];

const listTable: OperationTable<ListFixture, "default", Input, MuximodSessionSummary[], ListContext> = {
  defaultFixture: createFixture,
  cases: listCases,
  execute: (fixture, input) => {
    const sessionName = input.managed ? "muximod" : "desktop";
    fixture.host = createHost(createSnapshot(sessionName, input.managed));
    return Effect.gen(function* () {
      fixture.result = yield* listSessions();
      return fixture.result;
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          terminalLayer({
            paneRepository: fixture.paneRepository,
            agentSessionRepository: fixture.agentSessionRepository,
            host: fixture.host,
            sessionManagement: createSessionManagement(),
            viewportManager: createViewport(),
            agentStatus: fixture.agentStatus,
          }),
          applicationClockLayer(clock),
        ),
      ),
    );
  },
  observe: (fixture) => ({
    managed: fixture.result.map((session) => session.managed),
  }),
};

const clock: ApplicationClock = { now: () => "2026-08-24T00:00:00.000Z" };

function createFixture(): FixtureHandle<ListFixture> {
  let records: Pane[] = [];
  const paneRepository: PaneRepository = {
    list: () => Effect.succeed([...records]),
    findById: (id) => Effect.succeed(records.find((record) => record.id === id)),
    findByHostPaneIdentity: (hostServerId, hostPaneId) =>
      Effect.succeed(
        records.find((record) => record.hostServerId === hostServerId && record.hostPaneId === hostPaneId),
      ),
    upsert: (record) =>
      Effect.sync(() => {
        records = [
          ...records.filter(
            (current) => current.hostServerId !== record.hostServerId || current.hostPaneId !== record.hostPaneId,
          ),
          record,
        ];
      }),
    pruneStalePanes: () => Effect.succeed(0),
  };
  const agentSessionRepository: AgentSessionRepository = {
    findById: () => Effect.succeed(undefined),
    findByName: () => Effect.succeed(undefined),
    list: () => Effect.succeed([]),
    insert: () => Effect.succeed(undefined),
    update: () => Effect.succeed(undefined),
    claimExecution: () => Effect.succeed(false),
    claimAbandonedExecution: () => Effect.succeed(false),
    attachExecution: () => Effect.succeed(false),
    setBackendSessionIdIfMissing: () => Effect.succeed(false),
    delete: () => Effect.succeed(undefined),
  };
  return {
    fixture: {
      host: createHost(createSnapshot("desktop", false)),
      paneRepository,
      agentSessionRepository,
      agentStatus: new Map(),
      result: [],
    },
  };
}

function createSessionManagement(): MuximodSessionManagement {
  return {
    newId: () => "managed-session",
    hasSession: () => Effect.succeed(false),
    findManagedSessionId: () => Effect.succeed(undefined),
    configureManagedSession: () => Effect.succeed(undefined),
  };
}

function createViewport(): MuximodViewport {
  return {
    handleTerminalHostHook: () => Effect.succeed(undefined),
    reassertMobileViewport: () => Effect.succeed(undefined),
  };
}

function createSnapshot(sessionName: string, managed: boolean): TerminalHostSnapshot {
  const pane: HostPaneSnapshot = {
    hostPaneId: "%1",
    hostServerId: "host-1",
    windowId: "@0",
    sessionName,
    windowName: "0",
    windowIndex: 0,
    paneIndex: 0,
    cwd: "/workspace",
    command: "zsh",
    title: "zsh",
    active: true,
    left: 0,
    top: 0,
    width: 120,
    height: 40,
    windowWidth: 120,
    windowHeight: 40,
    ...(managed ? { muximodManagedSessionId: "managed-session-id" } : {}),
  };
  return {
    available: true,
    hostServerId: "host-1",
    hostServerScope: "host-scope",
    panes: [pane],
  };
}

function createHost(snapshot: TerminalHostSnapshot): MuximodHost {
  return {
    newId: () => "generated-pane",
    hasSession: () => Effect.succeed(false),
    createManagedSession: () => Effect.succeed("managed-session-id"),
    killSession: () => Effect.succeed(undefined),
    attachSession: () => Effect.succeed(0),
    createManagedPane: () => Effect.succeed("%2"),
    resolvePane: (target) => Effect.succeed({ hostPaneId: target, windowId: "@0", sessionName: "desktop" }),
    isWindowZoomed: () => Effect.succeed(false),
    splitPane: () => Effect.succeed("%2"),
    listPanesSnapshot: () => Effect.succeed(snapshot),
    setAgentPaneMetadata: () => Effect.succeed(undefined),
    setAgentExecutionMetadata: () => Effect.succeed(undefined),
    clearAgentExecutionMetadata: () => Effect.succeed(false),
    resetAgentPaneMetadata: () => Effect.succeed(undefined),
    isProcessAlive: () => Effect.succeed(false),
    classifyCommand: () => Effect.succeed({ kind: "shell", agentId: "shell" }),
    observeUnmanagedAgent: (_paneId, fallbackState) => Effect.succeed({ state: fallbackState }),
  };
}

describe("session listing", () => {
  runOperationTable(it as unknown as TestRegistrar, listTable);
});
