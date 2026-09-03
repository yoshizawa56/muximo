import {
  hasError,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  AgentSession,
  AgentSessionId,
  clearPatch,
  Pane,
  PaneId,
  Workspace,
  type WorkspaceCreateInput,
  WorkspaceId,
} from "./index.js";

type EmptyContext = {};

const workspaceInput: WorkspaceCreateInput = {
  id: WorkspaceId.create("workspace-1"),
  rootPath: "/work/project",
  name: "  Project  ",
  isGit: true,
  setupScriptPath: "/config/setup",
  cleanupScriptPath: "/config/cleanup",
};

const workspace: Workspace = Workspace.create({
  id: WorkspaceId.create("workspace-1"),
  rootPath: "/work/project",
  name: "Project",
  isGit: true,
  setupScriptPath: "/config/setup",
  cleanupScriptPath: "/config/cleanup",
});

const pane: Pane = Pane.create({
  id: PaneId.create("pane-1"),
  hostPaneId: "%1",
  hostServerId: "host-1",
  sessionName: "muximod",
  windowId: "@0",
  kind: "shell",
  name: "shell",
  cwd: "/work/project",
  workspaceId: workspace.id,
  agentId: undefined,
  initialState: "running",
  title: "Shell",
  lastSeenAt: "2026-08-15T00:00:00.000Z",
});

const agentSession: AgentSession = AgentSession.create({
  id: AgentSessionId.create("session-1"),
  name: "review",
  backend: "claude",
  status: "ready",
  workspaceId: workspace.id,
  workspaceRoot: workspace.rootPath,
  workspaceName: workspace.name,
  useWorktree: false,
  setupRan: false,
  resuming: false,
  lastActivityAt: "2026-08-15T00:00:00.000Z",
});

type WorkspaceOperation =
  | { kind: "create"; input: WorkspaceCreateInput }
  | { kind: "clear-cleanup-hook" }
  | { kind: "reject-invalid-current" }
  | { kind: "reject-id-update" };

const workspaceCases = [
  {
    name: "creates a normalized and validated workspace",
    input: { kind: "create", input: workspaceInput },
    assert: [
      returns<EmptyContext, Workspace>({
        ...workspace,
        name: "Project",
      } as Workspace),
    ],
  },
  {
    name: "updates a workspace through a validated clear patch",
    input: { kind: "clear-cleanup-hook" },
    assert: [returns<EmptyContext, Workspace>({ ...workspace, cleanupScriptPath: undefined } as Workspace)],
  },
  {
    name: "rejects an invalid current workspace before applying an update",
    input: { kind: "reject-invalid-current" },
    assert: [hasError<EmptyContext, Workspace>({ code: "invalid_entity", _tag: "InvalidEntityError" })],
  },
  {
    name: "rejects an identity update",
    input: { kind: "reject-id-update" },
    assert: [
      hasError<EmptyContext, Workspace>({
        message: "Workspace update cannot change immutable field: id",
        _tag: "ImmutableEntityFieldError",
      }),
    ],
  },
] satisfies readonly OperationCase<"default", WorkspaceOperation, Workspace, EmptyContext>[];

const workspaceTable: OperationTable<undefined, "default", WorkspaceOperation, Workspace, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: workspaceCases,
  execute: (_fixture, input) => {
    if (input.kind === "create") return Workspace.create(input.input);
    if (input.kind === "clear-cleanup-hook") return workspace.update({ cleanupScriptPath: clearPatch });
    if (input.kind === "reject-id-update") {
      return workspace.update({ id: WorkspaceId.create("workspace-2") } as never);
    }
    return Workspace.restore({ ...workspace, name: "" });
  },
  observe: () => ({}),
};

type PaneOperation =
  | { kind: "create" }
  | { kind: "clear-title" }
  | { kind: "reject-invalid-current" }
  | { kind: "reject-immutable-update" }
  | { kind: "reject-host-pane-identity-update" }
  | { kind: "reject-host-server-identity-update" }
  | { kind: "reject-state-update" }
  | { kind: "reset-state" }
  | { kind: "transition-state" };

const paneCases = [
  {
    name: "creates a validated pane",
    input: { kind: "create" },
    assert: [returns<EmptyContext, Pane>(pane)],
  },
  {
    name: "updates a pane through a validated clear patch",
    input: { kind: "clear-title" },
    assert: [returns<EmptyContext, Pane>({ ...pane, title: undefined } as Pane)],
  },
  {
    name: "rejects an invalid current pane before applying an update",
    input: { kind: "reject-invalid-current" },
    assert: [hasError<EmptyContext, Pane>({ code: "invalid_entity", _tag: "InvalidEntityError" })],
  },
  {
    name: "rejects an immutable identity update",
    input: { kind: "reject-immutable-update" },
    assert: [
      hasError<EmptyContext, Pane>({
        message: "Pane update cannot change immutable field: id",
        _tag: "ImmutableEntityFieldError",
      }),
    ],
  },
  {
    name: "rejects a host pane identity update",
    input: { kind: "reject-host-pane-identity-update" },
    assert: [
      hasError<EmptyContext, Pane>({
        message: "Pane update cannot change immutable field: hostPaneId",
        _tag: "ImmutableEntityFieldError",
      }),
    ],
  },
  {
    name: "rejects a host server identity update",
    input: { kind: "reject-host-server-identity-update" },
    assert: [
      hasError<EmptyContext, Pane>({
        message: "Pane update cannot change immutable field: hostServerId",
        _tag: "ImmutableEntityFieldError",
      }),
    ],
  },
  {
    name: "rejects a direct state update",
    input: { kind: "reject-state-update" },
    assert: [
      hasError<EmptyContext, Pane>({
        message: "Pane update cannot change immutable field: state",
        _tag: "ImmutableEntityFieldError",
      }),
    ],
  },
  {
    name: "resets a pane state when a new execution reuses the pane",
    input: { kind: "reset-state" },
    assert: [
      returns<EmptyContext, Pane>({
        ...pane,
        state: "running",
        lastSeenAt: "2026-08-15T00:01:00.000Z",
      } as Pane),
    ],
  },
  {
    name: "transitions state with an explicit reason and time",
    input: { kind: "transition-state" },
    assert: [
      returns<EmptyContext, Pane>({
        ...pane,
        state: "waiting_input",
        lastSeenAt: "2026-08-15T00:01:00.000Z",
      } as Pane),
    ],
  },
] satisfies readonly OperationCase<"default", PaneOperation, Pane, EmptyContext>[];

const paneTable: OperationTable<undefined, "default", PaneOperation, Pane, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: paneCases,
  execute: (_fixture, input) => {
    if (input.kind === "create") {
      const { state, ...createInput } = pane;
      return Pane.create({ ...createInput, initialState: state });
    }
    if (input.kind === "clear-title") return pane.update({ title: clearPatch });
    if (input.kind === "reject-invalid-current") {
      return Pane.restore({ ...pane, name: "" });
    }
    if (input.kind === "reject-immutable-update") {
      return pane.update({ id: PaneId.create("pane-2") } as never);
    }
    if (input.kind === "reject-host-pane-identity-update") {
      return pane.update({ hostPaneId: "%2" } as never);
    }
    if (input.kind === "reject-host-server-identity-update") {
      return pane.update({ hostServerId: "host-2" } as never);
    }
    if (input.kind === "reject-state-update") {
      return pane.update({ state: "completed" } as never);
    }
    if (input.kind === "reset-state") {
      const { state, ...createInput } = pane;
      return Pane.create({ ...createInput, initialState: "failed" }).resetTo(
        "running",
        "new execution observed",
        "2026-08-15T00:01:00.000Z",
      );
    }
    return pane.transitionTo("waiting_input", "agent requested input", "2026-08-15T00:01:00.000Z");
  },
  observe: () => ({}),
};

type AgentSessionOperation =
  | { kind: "create" }
  | { kind: "update-name" }
  | { kind: "reject-invalid-current" }
  | { kind: "reject-id-update" };

const agentSessionCases = [
  {
    name: "creates a normalized and validated agent session",
    input: { kind: "create" },
    assert: [returns<EmptyContext, AgentSession>({ ...agentSession, name: "review" } as AgentSession)],
  },
  {
    name: "updates an agent session through its domain name rule",
    input: { kind: "update-name" },
    assert: [returns<EmptyContext, AgentSession>({ ...agentSession, name: "api-review" } as AgentSession)],
  },
  {
    name: "rejects an invalid current agent session before applying an update",
    input: { kind: "reject-invalid-current" },
    assert: [hasError<EmptyContext, AgentSession>({ code: "invalid_entity", _tag: "InvalidEntityError" })],
  },
  {
    name: "rejects an identity update",
    input: { kind: "reject-id-update" },
    assert: [
      hasError<EmptyContext, AgentSession>({
        message: "AgentSession update cannot change immutable field: id",
        _tag: "ImmutableEntityFieldError",
      }),
    ],
  },
] satisfies readonly OperationCase<"default", AgentSessionOperation, AgentSession, EmptyContext>[];

const agentSessionTable: OperationTable<undefined, "default", AgentSessionOperation, AgentSession, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: agentSessionCases,
  execute: (_fixture, input) => {
    if (input.kind === "create") return AgentSession.create({ ...agentSession, name: "Review" });
    if (input.kind === "update-name") return agentSession.update({ name: " API review " });
    if (input.kind === "reject-id-update") {
      return agentSession.update({ id: AgentSessionId.create("session-2") } as never);
    }
    return AgentSession.restore({ ...agentSession, name: "" });
  },
  observe: () => ({}),
};

describe("domain entities", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, workspaceTable);
  runOperationTable(register, paneTable);
  runOperationTable(register, agentSessionTable);
});
