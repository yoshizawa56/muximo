import type { WorkspaceRecord } from "@muximo/domain";
import type { ProcessResult, WorkspaceResolverPort } from "./agent-sessions.js";

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
  run(input: ShellProcessInput): Promise<ProcessResult>;
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

export interface ShellWorktreePort {
  create(
    workspace: WorkspaceRecord,
    name: string,
  ): Promise<{
    worktreeRoot?: string;
    worktreePath?: string;
    branch?: string;
    baseCommit?: string;
  }>;
  copyFiles(
    target: Pick<ShellWorktree, "workspaceRoot" | "worktreePath">,
    patterns: readonly string[],
  ): Promise<boolean>;
  remove(input: ShellWorktree): Promise<void>;
}

export interface ShellHookPort {
  resolveHook(value: string, workspaceRoot: string): Promise<string>;
  runShell(input: {
    hook: string | null;
    kind: "setup" | "cleanup";
    runDir: string;
    name: string;
    workspaceRoot: string;
    worktreePath: string;
  }): Promise<boolean>;
}

export interface ShellPanePort {
  markShell(name: string): void;
  restoreShell(): void;
}

export interface SessionWorktreeLookupPort {
  findWorktreePath(workspaceId: WorkspaceRecord["id"], sessionName: string, fallbackCwd: string): Promise<string>;
}

export type RunShellDependencies = {
  cwd: string;
  paneName: string;
  workspace: WorkspaceResolverPort;
  sessions: SessionWorktreeLookupPort;
  process: ShellProcessPort;
  worktrees: ShellWorktreePort;
  hooks: ShellHookPort;
  panes: ShellPanePort;
};
