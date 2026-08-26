import type { PaneRecord } from "@muximo/domain";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { ApplicationClock, MuximodSessionSummary } from "../../ports/application.js";
import type { HostPaneSnapshot, MuximodHostPort, TerminalHostSnapshot } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import { listSessions } from "./list-sessions.js";

type Input = { managed: boolean };

type ListFixture = {
  host: MuximodHostPort;
  paneRepository: PaneRepository;
  agentSessionRepository: AgentSessionRepository;
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
  execute: async (fixture, input) => {
    const sessionName = input.managed ? "muximod" : "desktop";
    fixture.host = createHost(createSnapshot(sessionName, input.managed));
    fixture.result = await listSessions(
      fixture.host,
      fixture.paneRepository,
      fixture.agentSessionRepository,
      new Map(),
      clock,
    );
    return fixture.result;
  },
  observe: (fixture) => ({
    managed: fixture.result.map((session) => session.managed),
  }),
};

const clock: ApplicationClock = { now: () => "2026-08-24T00:00:00.000Z" };

function createFixture(): FixtureHandle<ListFixture> {
  let records: PaneRecord[] = [];
  const paneRepository: PaneRepository = {
    list: async () => records,
    findById: async (id) => records.find((record) => record.id === id),
    findByHostPaneIdentity: async (hostServerId, hostPaneId) =>
      records.find((record) => record.hostServerId === hostServerId && record.hostPaneId === hostPaneId),
    upsert: async (record) => {
      records = [
        ...records.filter(
          (current) => current.hostServerId !== record.hostServerId || current.hostPaneId !== record.hostPaneId,
        ),
        record,
      ];
    },
    pruneStalePanes: async () => 0,
  };
  const agentSessionRepository: AgentSessionRepository = {
    findById: async () => undefined,
    findByName: async () => undefined,
    list: async () => [],
    insert: async () => undefined,
    update: async () => undefined,
    claimExecution: async () => false,
    setBackendSessionIdIfMissing: async () => false,
    delete: async () => undefined,
  };
  return {
    fixture: {
      host: createHost(createSnapshot("desktop", false)),
      paneRepository,
      agentSessionRepository,
      result: [],
    },
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

function createHost(snapshot: TerminalHostSnapshot): MuximodHostPort {
  return {
    newId: () => "generated-pane",
    hasSession: async () => false,
    createManagedSession: async () => "managed-session-id",
    killSession: async () => undefined,
    attachSession: async () => 0,
    createManagedPane: async () => "%2",
    resolvePane: async (target) => ({ hostPaneId: target, windowId: "@0", sessionName: "desktop" }),
    isWindowZoomed: async () => false,
    splitPane: async () => "%2",
    listPanesSnapshot: async () => snapshot,
    setAgentPaneMetadata: async () => undefined,
    setAgentExecutionMetadata: async () => undefined,
    clearAgentExecutionMetadata: async () => false,
    resetAgentPaneMetadata: async () => undefined,
    isProcessAlive: async () => false,
    classifyCommand: async () => ({ kind: "shell", agentId: "shell" }),
    observeUnmanagedAgent: async (_paneId, fallbackState) => ({ state: fallbackState }),
    isManagedAgentExecution: async () => false,
  };
}

describe("session listing", () => {
  runOperationTable(it as unknown as TestRegistrar, listTable);
});
