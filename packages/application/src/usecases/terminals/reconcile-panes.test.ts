import { AgentSession, AgentSessionId, clearPatch, Pane, PaneId, type PaneState, WorkspaceId } from "@muximo/domain";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import { applicationClockLayer } from "../../effect-runtime.js";
import type { ApplicationClock } from "../../ports/application.js";
import type {
  MuximodHostPort,
  MuximodSessionManagementPort,
  MuximodViewportPort,
  TerminalHostSnapshot,
} from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import { reconcilePanes } from "./reconcile-panes.js";
import { terminalLayer } from "./terminal-services.js";

type Input = {
  execution: "adopted" | "manual";
  marker: "shell" | "none";
  command: "codex" | "shell";
  identity?: "valid" | "missing";
  existingState?: PaneState;
};

type ReconcileResult = "agent" | "shell" | "unknown";

type ReconcileContext = {
  kind: ReconcileResult | undefined;
  agentSessionId: string | undefined;
  state: PaneState | undefined;
};

type ReconcileFixture = {
  session: AgentSession;
  host: MuximodHostPort;
  repository: PaneRepository;
  sessions: AgentSessionRepository;
  status: Map<string, { state: PaneState; recentOutput?: string }>;
  records: Pane[];
  record: { kind: ReconcileResult; agentSessionId?: string; state?: PaneState } | undefined;
};

const cases = [
  {
    name: "adopted execution wins over managed shell metadata",
    input: { execution: "adopted", marker: "shell", command: "codex" },
    assert: [
      returns<ReconcileContext, ReconcileResult>("agent"),
      hasObserved<ReconcileContext, ReconcileResult>("kind", "agent"),
      hasObserved<ReconcileContext, ReconcileResult>("agentSessionId", "session-id"),
    ],
  },
  {
    name: "manual agent command remains a managed shell",
    input: { execution: "manual", marker: "shell", command: "codex" },
    assert: [
      returns<ReconcileContext, ReconcileResult>("shell"),
      hasObserved<ReconcileContext, ReconcileResult>("kind", "shell"),
      hasObserved<ReconcileContext, ReconcileResult>("agentSessionId", undefined),
    ],
  },
  {
    name: "adopted execution is classified without an agent marker",
    input: { execution: "adopted", marker: "none", command: "codex" },
    assert: [
      returns<ReconcileContext, ReconcileResult>("agent"),
      hasObserved<ReconcileContext, ReconcileResult>("kind", "agent"),
      hasObserved<ReconcileContext, ReconcileResult>("agentSessionId", "session-id"),
    ],
  },
  {
    name: "adopted execution remains adopted before the backend process replaces the shell",
    input: { execution: "adopted", marker: "shell", command: "shell" },
    assert: [
      returns<ReconcileContext, ReconcileResult>("agent"),
      hasObserved<ReconcileContext, ReconcileResult>("kind", "agent"),
      hasObserved<ReconcileContext, ReconcileResult>("agentSessionId", "session-id"),
    ],
  },
  {
    name: "new execution resets a terminal pane state before adoption",
    input: { execution: "adopted", marker: "shell", command: "shell", existingState: "failed" },
    assert: [
      returns<ReconcileContext, ReconcileResult>("agent"),
      {
        name: "stores the new execution as running",
        check: (context: ReconcileContext) => expect(context.state).toBe("running"),
      },
    ],
  },
  {
    name: "does not adopt metadata when the execution owner timestamp is missing",
    input: { execution: "adopted", marker: "shell", command: "codex", identity: "missing" },
    assert: [
      returns<ReconcileContext, ReconcileResult>("shell"),
      hasObserved<ReconcileContext, ReconcileResult>("kind", "shell"),
      hasObserved<ReconcileContext, ReconcileResult>("agentSessionId", undefined),
    ],
  },
] satisfies readonly OperationCase<"default", Input, ReconcileResult, ReconcileContext>[];

const table: OperationTable<ReconcileFixture, "default", Input, ReconcileResult, ReconcileContext> = {
  defaultFixture: createFixture,
  cases,
  execute: (fixture, input) => {
    fixture.records = input.existingState
      ? [
          Pane.create({
            id: PaneId.create("persisted-pane"),
            hostPaneId: "%1",
            hostServerId: "host-1",
            agentSessionId: AgentSessionId.create("previous-session"),
            agentExecutionId: "previous-execution",
            sessionName: "managed",
            windowId: "@0",
            kind: "agent",
            name: "previous",
            cwd: "/workspace",
            workspaceId: WorkspaceId.create("workspace-id"),
            agentId: "codex",
            initialState: input.existingState,
            lastSeenAt: "2026-08-23T00:00:00.000Z",
          }),
        ]
      : [];
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
          command: input.command,
          title: input.command,
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
    if (input.identity === "missing") fixture.session = fixture.session.update({ executionStartedAt: clearPatch });
    fixture.host = createHost(snapshot);
    return Effect.gen(function* () {
      const [record] = yield* reconcilePanes(snapshot);
      fixture.record = {
        kind: record?.kind ?? "unknown",
        ...(record?.agentSessionId ? { agentSessionId: record.agentSessionId } : {}),
        ...(record?.state ? { state: record.state } : {}),
      };
      return record?.kind ?? "unknown";
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          terminalLayer({
            paneRepository: fixture.repository,
            agentSessionRepository: fixture.sessions,
            host: fixture.host,
            sessionManagement: createSessionManagement(),
            viewportManager: createViewport(),
            agentStatus: fixture.status,
          }),
          applicationClockLayer(clock),
        ),
      ),
    );
  },
  observe: (fixture) => ({
    kind: fixture.record?.kind,
    agentSessionId: fixture.record?.agentSessionId,
    state: fixture.record?.state,
  }),
};

const clock: ApplicationClock = { now: () => "2026-08-24T00:00:00.000Z" };

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
    executionStartedAt: "2026-08-23T00:00:00.000Z",
    lastActivityAt: "2026-08-23T00:00:00.000Z",
  });
  const status = new Map<string, { state: PaneState; recentOutput?: string }>();
  const sessions = new Map<string, AgentSession>([[session.id, session]]);
  const fixture = {
    session,
    host: createHost({ available: false, hostServerId: null, hostServerScope: null, panes: [] }),
    repository: undefined as unknown as PaneRepository,
    sessions: undefined as unknown as AgentSessionRepository,
    status,
    records: [] as Pane[],
    record: undefined as ReconcileFixture["record"],
  } satisfies ReconcileFixture;
  const repository: PaneRepository = {
    list: () => Effect.succeed([...fixture.records]),
    findById: (id) => Effect.succeed(fixture.records.find((record) => record.id === id)),
    findByHostPaneIdentity: (hostServerId, hostPaneId) =>
      Effect.succeed(
        fixture.records.find((record) => record.hostServerId === hostServerId && record.hostPaneId === hostPaneId),
      ),
    upsert: (record) =>
      Effect.sync(() => {
        fixture.records = [
          ...fixture.records.filter(
            (current) => current.hostServerId !== record.hostServerId || current.hostPaneId !== record.hostPaneId,
          ),
          record,
        ];
      }),
    pruneStalePanes: () => Effect.succeed(0),
  };
  const sessionRepository: AgentSessionRepository = {
    findById: (id) => Effect.succeed(id === fixture.session.id ? fixture.session : sessions.get(id)),
    findByName: () => Effect.succeed(undefined),
    list: () => Effect.succeed([...sessions.values()]),
    insert: (record) =>
      Effect.sync(() => {
        sessions.set(record.id, record);
      }),
    update: (record) =>
      Effect.sync(() => {
        sessions.set(record.id, record);
      }),
    claimExecution: () => Effect.succeed(false),
    claimAbandonedExecution: () => Effect.succeed(false),
    attachExecution: () => Effect.succeed(false),
    setBackendSessionIdIfMissing: () => Effect.succeed(false),
    delete: (id) =>
      Effect.sync(() => {
        sessions.delete(id);
      }),
  };
  fixture.repository = repository;
  fixture.sessions = sessionRepository;
  return { fixture };
}

function createSessionManagement(): MuximodSessionManagementPort {
  return {
    newId: () => "managed-session",
    hasSession: () => Effect.succeed(false),
    findManagedSessionId: () => Effect.succeed(undefined),
    configureManagedSession: () => Effect.succeed(undefined),
  };
}

function createViewport(): MuximodViewportPort {
  return {
    handleTerminalHostHook: () => Effect.succeed(undefined),
    reassertMobileViewport: () => Effect.succeed(undefined),
  };
}

function createHost(snapshot: TerminalHostSnapshot): MuximodHostPort {
  return {
    newId: () => "generated-pane",
    hasSession: () => Effect.succeed(false),
    createManagedSession: () => Effect.succeed("managed"),
    killSession: () => Effect.succeed(undefined),
    attachSession: () => Effect.succeed(0),
    createManagedPane: () => Effect.succeed("%2"),
    resolvePane: (target) => Effect.succeed({ hostPaneId: target, windowId: "@0", sessionName: "managed" }),
    isWindowZoomed: () => Effect.succeed(false),
    splitPane: () => Effect.succeed("%2"),
    listPanesSnapshot: () => Effect.succeed(snapshot),
    setAgentPaneMetadata: () => Effect.succeed(undefined),
    setAgentExecutionMetadata: () => Effect.succeed(undefined),
    clearAgentExecutionMetadata: () => Effect.succeed(false),
    resetAgentPaneMetadata: () => Effect.succeed(undefined),
    isProcessAlive: () => Effect.succeed(true),
    classifyCommand: (command) =>
      Effect.succeed(command === "codex" ? { kind: "agent", agentId: "codex" } : { kind: "shell", agentId: "shell" }),
    observeUnmanagedAgent: (_paneId, fallbackState) => Effect.succeed({ state: fallbackState }),
  };
}

describe("pane reconciliation classification", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
