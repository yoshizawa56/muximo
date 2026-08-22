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
  canTransitionPaneState,
  isAttentionState,
  paneKindForCommand,
  transitionPaneState,
  validateWorkspaceSelection,
  WorkspaceId,
  type PaneState,
  type WorkspaceDirectoryOption,
  type WorkspaceSelection,
} from "./index.js";

type EmptyContext = {};
type TransitionInput = { from: PaneState; to: PaneState };
const transitionCases = [
  { name: "allows a running agent to wait for input", input: { from: "running", to: "waiting_input" }, assert: [returns<EmptyContext, boolean>(true)] },
  { name: "rejects a transition after completion", input: { from: "completed", to: "running" }, assert: [returns<EmptyContext, boolean>(false)] },
] satisfies readonly OperationCase<"default", TransitionInput, boolean, EmptyContext>[];

const transitionTable: OperationTable<undefined, "default", TransitionInput, boolean, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: transitionCases,
  execute: (_fixture, input) => canTransitionPaneState(input.from, input.to),
  observe: () => ({}),
};

type RecordInput = { current: PaneState; next: PaneState; reason: string; at: string };
const recordCases = [
  {
    name: "returns a transition record for an allowed change",
    input: { current: "running", next: "waiting_approval", reason: "agent asked for approval", at: "2026-08-09T00:00:00.000Z" },
    assert: [returns<EmptyContext, ReturnType<typeof transitionPaneState>>({ from: "running", to: "waiting_approval", reason: "agent asked for approval", at: "2026-08-09T00:00:00.000Z" })],
  },
] satisfies readonly OperationCase<"default", RecordInput, ReturnType<typeof transitionPaneState>, EmptyContext>[];

const recordTable: OperationTable<undefined, "default", RecordInput, ReturnType<typeof transitionPaneState>, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: recordCases,
  execute: (_fixture, input) => transitionPaneState(input.current, input.next, input.reason, input.at),
  observe: () => ({}),
};

type AttentionInput = { state: PaneState };
const attentionCases = [
  { name: "classifies waiting input as attention", input: { state: "waiting_input" }, assert: [returns<EmptyContext, boolean>(true)] },
  { name: "classifies running as ordinary", input: { state: "running" }, assert: [returns<EmptyContext, boolean>(false)] },
] satisfies readonly OperationCase<"default", AttentionInput, boolean, EmptyContext>[];

const attentionTable: OperationTable<undefined, "default", AttentionInput, boolean, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: attentionCases,
  execute: (_fixture, input) => isAttentionState(input.state),
  observe: () => ({}),
};

type CommandInput = { command: string };
const commandCases = [
  { name: "classifies zsh as a shell", input: { command: "/bin/zsh -l" }, assert: [returns<EmptyContext, string>("shell")] },
  { name: "classifies a bare zsh as a shell", input: { command: "zsh" }, assert: [returns<EmptyContext, string>("shell")] },
  { name: "classifies codex as an agent", input: { command: "codex --profile local-agent" }, assert: [returns<EmptyContext, string>("agent")] },
  { name: "classifies claude as an agent", input: { command: "claude --session-id example" }, assert: [returns<EmptyContext, string>("agent")] },
] satisfies readonly OperationCase<"default", CommandInput, string, EmptyContext>[];

const commandTable: OperationTable<undefined, "default", CommandInput, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: commandCases,
  execute: (_fixture, input) => paneKindForCommand(input.command),
  observe: () => ({}),
};

const workspace: WorkspaceDirectoryOption = {
  id: WorkspaceId.create("workspace-1"),
  name: "muximo",
  rootPath: "/work/muximo",
  isGit: true,
  setupScriptPath: "/Users/me/.config/muximo/setup",
  cleanupScriptPath: "/Users/me/.config/muximo/cleanup",
  worktreeCopyPatterns: [".env", "config/**/*.local.json"],
};

type WorkspaceInput = { selection: WorkspaceSelection; workspace: WorkspaceDirectoryOption | undefined };
const workspaceCases = [
  { name: "accepts a workspace directory", input: { selection: { workspaceId: workspace.id, mode: "workspace" }, workspace }, assert: [returns<EmptyContext, WorkspaceSelection>({ workspaceId: workspace.id, mode: "workspace" })] },
  { name: "accepts a workspace worktree", input: { selection: { workspaceId: workspace.id, mode: "worktree" }, workspace }, assert: [returns<EmptyContext, WorkspaceSelection>({ workspaceId: workspace.id, mode: "worktree" })] },
  { name: "rejects worktrees for non-git directories", input: { selection: { workspaceId: workspace.id, mode: "worktree" }, workspace: { ...workspace, isGit: false } }, assert: [hasError<EmptyContext, WorkspaceSelection>({ code: "worktree_not_supported" })] },
  { name: "rejects an unknown workspace", input: { selection: { workspaceId: WorkspaceId.create("missing"), mode: "workspace" }, workspace: undefined }, assert: [hasError<EmptyContext, WorkspaceSelection>({ code: "workspace_not_found" })] },
] satisfies readonly OperationCase<"default", WorkspaceInput, WorkspaceSelection, EmptyContext>[];

const workspaceTable: OperationTable<undefined, "default", WorkspaceInput, WorkspaceSelection, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: workspaceCases,
  execute: (_fixture, input) => validateWorkspaceSelection(input.selection, input.workspace),
  observe: () => ({}),
};

describe("domain rules", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, transitionTable);
  runOperationTable(register, recordTable);
  runOperationTable(register, attentionTable);
  runOperationTable(register, commandTable);
  runOperationTable(register, workspaceTable);
});
