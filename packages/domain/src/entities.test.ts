import { describe, it } from "vitest";
import {
  hasError,
  noFixture,
  returns,
  runOperationTable,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import {
  AgentSession,
  AgentSessionId,
  clearPatch,
  Pane,
  PaneId,
  Workspace,
  WorkspaceId,
  type AgentSessionRecord,
  type PaneRecord,
  type WorkspaceCreateInput,
  type WorkspaceRecord,
} from "./index.js";

type EmptyContext = {};

const workspaceInput: WorkspaceCreateInput = {
  id: WorkspaceId.create("workspace-1"),
  rootPath: "/work/project",
  name: "  Project  ",
  isGit: true,
  setupScriptPath: "/config/setup",
  cleanupScriptPath: "/config/cleanup",
  worktreeCopyPatterns: [" .env ", ".env", "config/*.local.json"],
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

const workspace: WorkspaceRecord = Workspace.create({
  id: WorkspaceId.create("workspace-1"),
  rootPath: "/work/project",
  name: "Project",
  isGit: true,
  setupScriptPath: "/config/setup",
  cleanupScriptPath: "/config/cleanup",
  worktreeCopyPatterns: [".env", "config/*.local.json"],
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
});

const pane: PaneRecord = Pane.create({
  id: PaneId.create("pane-1"),
  tmuxPaneId: "%1",
  sessionName: "muximod",
  windowId: "@0",
  kind: "shell",
  name: "shell",
  cwd: "/work/project",
  workspaceId: workspace.id,
  agentId: undefined,
  state: "running",
  title: "Shell",
  lastSeenAt: "2026-08-15T00:00:00.000Z",
});

const agentSession: AgentSessionRecord = AgentSession.create({
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
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
});

type WorkspaceOperation =
  | { kind: "create"; input: WorkspaceCreateInput }
  | { kind: "clear-cleanup-hook" }
  | { kind: "reject-invalid-current" };

const workspaceCases = [
  {
    name: "creates a normalized and validated workspace",
    input: { kind: "create", input: workspaceInput },
    assert: [returns<EmptyContext, WorkspaceRecord>({
      ...workspace,
      name: "Project",
      worktreeCopyPatterns: [".env", "config/*.local.json"],
    })],
  },
  {
    name: "updates a workspace through a validated clear patch",
    input: { kind: "clear-cleanup-hook" },
    assert: [returns<EmptyContext, WorkspaceRecord>({ ...workspace, cleanupScriptPath: undefined })],
  },
  {
    name: "rejects an invalid current workspace before applying an update",
    input: { kind: "reject-invalid-current" },
    assert: [hasError<EmptyContext, WorkspaceRecord>({ name: "ZodError" })],
  },
] satisfies readonly OperationCase<"default", WorkspaceOperation, WorkspaceRecord, EmptyContext>[];

const workspaceTable: OperationTable<undefined, "default", WorkspaceOperation, WorkspaceRecord, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: workspaceCases,
  execute: (_fixture, input) => {
    if (input.kind === "create") return Workspace.create(input.input);
    if (input.kind === "clear-cleanup-hook") return Workspace.update(workspace, { cleanupScriptPath: clearPatch });
    return Workspace.update({ ...workspace, name: "" } as WorkspaceRecord, { name: "renamed" });
  },
  observe: () => ({}),
};

type PaneOperation =
  | { kind: "create" }
  | { kind: "clear-title" }
  | { kind: "reject-invalid-current" };

const paneCases = [
  {
    name: "creates a validated pane",
    input: { kind: "create" },
    assert: [returns<EmptyContext, PaneRecord>(pane)],
  },
  {
    name: "updates a pane through a validated clear patch",
    input: { kind: "clear-title" },
    assert: [returns<EmptyContext, PaneRecord>({ ...pane, title: undefined })],
  },
  {
    name: "rejects an invalid current pane before applying an update",
    input: { kind: "reject-invalid-current" },
    assert: [hasError<EmptyContext, PaneRecord>({ name: "ZodError" })],
  },
] satisfies readonly OperationCase<"default", PaneOperation, PaneRecord, EmptyContext>[];

const paneTable: OperationTable<undefined, "default", PaneOperation, PaneRecord, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: paneCases,
  execute: (_fixture, input) => {
    if (input.kind === "create") return Pane.create(pane);
    if (input.kind === "clear-title") return Pane.update(pane, { title: clearPatch });
    return Pane.update({ ...pane, state: "invalid" } as unknown as PaneRecord, { state: "running" });
  },
  observe: () => ({}),
};

type AgentSessionOperation =
  | { kind: "create" }
  | { kind: "update-name" }
  | { kind: "reject-invalid-current" };

const agentSessionCases = [
  {
    name: "creates a normalized and validated agent session",
    input: { kind: "create" },
    assert: [returns<EmptyContext, AgentSessionRecord>({ ...agentSession, name: "review" })],
  },
  {
    name: "updates an agent session through its domain name rule",
    input: { kind: "update-name" },
    assert: [returns<EmptyContext, AgentSessionRecord>({ ...agentSession, name: "api-review" })],
  },
  {
    name: "rejects an invalid current agent session before applying an update",
    input: { kind: "reject-invalid-current" },
    assert: [hasError<EmptyContext, AgentSessionRecord>({ name: "ZodError" })],
  },
] satisfies readonly OperationCase<"default", AgentSessionOperation, AgentSessionRecord, EmptyContext>[];

const agentSessionTable: OperationTable<undefined, "default", AgentSessionOperation, AgentSessionRecord, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: agentSessionCases,
  execute: (_fixture, input) => {
    if (input.kind === "create") return AgentSession.create({ ...agentSession, name: "Review" });
    if (input.kind === "update-name") return AgentSession.update(agentSession, { name: " API review " });
    return AgentSession.update({ ...agentSession, name: "" } as AgentSessionRecord, { status: "running" });
  },
  observe: () => ({}),
};

describe("domain entities", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, workspaceTable);
  runOperationTable(register, paneTable);
  runOperationTable(register, agentSessionTable);
});
