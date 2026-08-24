import { AgentSession, AgentSessionId, type AgentSessionRecord, type PaneState, WorkspaceId } from "@muximo/domain";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { MuximodClock } from "../../ports/application.js";
import type { MuximodHostPort, TerminalHostSnapshot } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import { reconcilePanes } from "./reconcile-panes.js";

type Input = {
  execution: "adopted" | "manual";
  marker: "shell" | "none";
};

type ReconcileResult = "agent" | "shell" | "unknown";

type ReconcileContext = {
  kind: ReconcileResult | undefined;
  agentSessionId: string | undefined;
};

type ReconcileFixture = {
  session: AgentSessionRecord;
  host: MuximodHostPort;
  repository: PaneRepository;
  sessions: AgentSessionRepository;
  status: Map<string, { state: PaneState; recentOutput?: string }>;
  record: { kind: ReconcileResult; agentSessionId?: string } | undefined;
};

const cases = [
  {
    name: "adopted execution wins over managed shell metadata",
    input: { execution: "adopted", marker: "shell" },
    assert: [
      returns<ReconcileContext, ReconcileResult>("agent"),
      hasObserved<ReconcileContext, ReconcileResult>("kind", "agent"),
      hasObserved<ReconcileContext, ReconcileResult>("agentSessionId", "session-id"),
    ],
  },
  {
    name: "manual agent command remains a managed shell",
    input: { execution: "manual", marker: "shell" },
    assert: [
      returns<ReconcileContext, ReconcileResult>("shell"),
      hasObserved<ReconcileContext, ReconcileResult>("kind", "shell"),
      hasObserved<ReconcileContext, ReconcileResult>("agentSessionId", undefined),
    ],
  },
  {
    name: "adopted execution is classified without an agent marker",
    input: { execution: "adopted", marker: "none" },
    assert: [
      returns<ReconcileContext, ReconcileResult>("agent"),
      hasObserved<ReconcileContext, ReconcileResult>("kind", "agent"),
      hasObserved<ReconcileContext, ReconcileResult>("agentSessionId", "session-id"),
    ],
  },
] satisfies readonly OperationCase<"default", Input, ReconcileResult, ReconcileContext>[];

const table: OperationTable<ReconcileFixture, "default", Input, ReconcileResult, ReconcileContext> = {
  defaultFixture: createFixture,
  cases,
  execute: async (fixture, input) => {
    const sessionId = input.execution === "adopted" ? fixture.session.id : undefined;
    const executionId = input.execution === "adopted" ? fixture.session.executionId : undefined;
    const snapshot: TerminalHostSnapshot = {
      available: true,
      hostServerId: "host-1",
      hostServerScope: "host-scope",
      panes: [
        {
          hostPaneId: "%1",
          hostServerId: "host-1",
          windowId: "@0",
          sessionName: "managed",
          windowName: "0",
          windowIndex: 0,
          paneIndex: 0,
          cwd: "/workspace",
          command: "codex",
          title: "codex",
          active: true,
          left: 0,
          top: 0,
          width: 120,
          height: 40,
          windowWidth: 120,
          windowHeight: 40,
          ...(input.marker === "shell" ? { muximodKind: "shell" } : {}),
          ...(sessionId && executionId ? { muximodSessionId: sessionId, muximodExecutionId: executionId } : {}),
        },
      ],
    };
    fixture.host = createHost(snapshot);
    const [record] = await reconcilePanes(
      fixture.host,
      fixture.repository,
      fixture.sessions,
      fixture.status,
      clock,
      snapshot,
    );
    fixture.record = {
      kind: record?.kind ?? "unknown",
      ...(record?.agentSessionId ? { agentSessionId: record.agentSessionId } : {}),
    };
    return record?.kind ?? "unknown";
  },
  observe: (fixture) => ({
    kind: fixture.record?.kind,
    agentSessionId: fixture.record?.agentSessionId,
  }),
};

const clock: MuximodClock = { now: () => "2026-08-24T00:00:00.000Z" };

function createFixture(): { fixture: ReconcileFixture } {
  const session = AgentSession.create({
    id: AgentSessionId.create("session-id"),
    name: "session",
    backend: "codex",
    status: "running",
    workspaceId: WorkspaceId.create("workspace-id"),
    workspaceRoot: "/workspace",
    workspaceName: "workspace",
    useWorktree: false,
    setupRan: false,
    resuming: false,
    executionId: "execution-id-123456",
    executionPid: 1234,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  });
  const status = new Map<string, { state: PaneState; recentOutput?: string }>();
  const sessions = new Map<string, AgentSessionRecord>([[session.id, session]]);
  let records: Awaited<ReturnType<PaneRepository["list"]>> = [];
  const repository: PaneRepository = {
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
  const sessionRepository: AgentSessionRepository = {
    findById: async (id) => sessions.get(id),
    findByName: async () => undefined,
    list: async () => [...sessions.values()],
    insert: async (record) => {
      sessions.set(record.id, record);
    },
    update: async (record) => {
      sessions.set(record.id, record);
    },
    claimExecution: async () => false,
    setBackendSessionIdIfMissing: async () => false,
    delete: async (id) => {
      sessions.delete(id);
    },
  };
  const fixture: ReconcileFixture = {
    session,
    host: createHost({ available: false, hostServerId: null, hostServerScope: null, panes: [] }),
    repository,
    sessions: sessionRepository,
    status,
    record: undefined,
  };
  return { fixture };
}

function createHost(snapshot: TerminalHostSnapshot): MuximodHostPort {
  return {
    newId: () => "generated-pane",
    hasSession: async () => false,
    createManagedSession: async () => "managed",
    killSession: async () => undefined,
    attachSession: async () => 0,
    createManagedPane: async () => "%2",
    resolvePane: async (target) => ({ hostPaneId: target, windowId: "@0", sessionName: "managed" }),
    isWindowZoomed: async () => false,
    splitPane: async () => "%2",
    listPanesSnapshot: async () => snapshot,
    setAgentPaneMetadata: async () => undefined,
    setAgentExecutionMetadata: async () => undefined,
    clearAgentExecutionMetadata: async () => false,
    resetAgentPaneMetadata: async () => undefined,
    isProcessAlive: async () => true,
    classifyCommand: async (command) =>
      command === "codex" ? { kind: "agent", agentId: "codex" } : { kind: "shell", agentId: "shell" },
    observeUnmanagedAgent: async (_paneId, fallbackState) => ({ state: fallbackState }),
    isManagedAgentExecution: async (command, backend) => command === backend,
  };
}

describe("pane reconciliation classification", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
