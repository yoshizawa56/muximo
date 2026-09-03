import type { Workspace, WorkspaceDirectoryOption } from "@muximo/domain";
import type { ApplicationEffect } from "../effect.js";
import type { ProcessResult } from "./agent-sessions.js";

export type RunShellInput = {
  shell?: string;
  command: readonly string[];
  exitAfterCommand: boolean;
  worktree: boolean;
  worktreeName?: string;
};

export type ShellProcessInput = {
  executable: string;
  args: readonly string[];
  cwd: string;
  interactive: boolean;
};

export interface ShellProcessPort {
  run(input: ShellProcessInput): ApplicationEffect<ProcessResult>;
}

export type ShellWorktree = {
  name: string;
  workspaceRoot: string;
  worktreeRoot: string | null;
  worktreePath: string;
  branch: string | null;
  baseCommit: string | null;
  setupHook: string | null;
  cleanupHook: string | null;
};

/** Complete allocation returned after a managed shell worktree is created. */
export type ShellWorktreeAllocation = {
  worktreeRoot: string | null;
  worktreePath: string;
  branch: string | null;
  baseCommit: string | null;
};

export interface ShellWorktreePort {
  create(workspace: WorkspaceDirectoryOption, name: string): ApplicationEffect<ShellWorktreeAllocation>;
  copyFiles(target: Pick<ShellWorktree, "workspaceRoot" | "worktreePath">): ApplicationEffect<boolean>;
  /** Returns false when safety policy deliberately retains the worktree. */
  remove(input: ShellWorktree): ApplicationEffect<boolean>;
}

export interface ShellHookPort {
  resolveHook(value: string, workspaceRoot: string): ApplicationEffect<string>;
  runShell(input: {
    hook: string | null;
    kind: "setup" | "cleanup";
    runDir: string;
    name: string;
    workspaceRoot: string;
    worktreePath: string;
  }): ApplicationEffect<boolean>;
}

export interface ShellPanePort {
  markShell(name: string): void;
  restoreShell(): void;
}

/** Resolves host shell context from daemon contract data and local host inputs. */
export interface ShellWorkspaceResolverPort {
  resolveCurrent(): ApplicationEffect<WorkspaceDirectoryOption>;
}

export interface SessionWorktreeLookupPort {
  findWorktreePath(workspaceId: Workspace["id"], sessionName: string, fallbackCwd: string): ApplicationEffect<string>;
}

export type RunShellDependencies = {
  cwd: string;
  paneName: string;
  /** Host-selected shell used when the command input does not override it. */
  defaultShell: string;
  workspace: ShellWorkspaceResolverPort;
  sessions: SessionWorktreeLookupPort;
  process: ShellProcessPort;
  worktrees: ShellWorktreePort;
  hooks: ShellHookPort;
  panes: ShellPanePort;
};
