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
