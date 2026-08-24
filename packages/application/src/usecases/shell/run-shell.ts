import type { ProcessResult } from "../../ports/agent-sessions.js";
import type { RunShellDependencies, RunShellInput, ShellWorktree } from "../../ports/shell.js";

export type RunShellResult = {
  process: ProcessResult;
};

/** Application workflow for an interactive shell and its optional managed worktree. */
export class RunShell {
  public constructor(private readonly deps: RunShellDependencies) {}

  public async execute(input: RunShellInput): Promise<RunShellResult> {
    this.deps.panes.markShell(this.deps.paneName);
    let worktree: ShellWorktree | undefined;
    try {
      let shellCwd = this.deps.cwd;
      if (input.command.length > 0) {
        const executable = input.command[0];
        if (!executable) throw new Error("shell command executable is missing");
        const result = await this.deps.process.run({
          executable,
          args: input.command.slice(1),
          cwd: this.deps.cwd,
          interactive: false,
        });
        if (input.exitAfterCommand) return { process: result };
        shellCwd = await this.deps.sessions.findWorktreePath(
          await this.deps.workspace.resolveCurrent().then((workspace) => workspace.id),
          this.deps.paneName,
          this.deps.cwd,
        );
      }
      if (input.worktree) {
        const workspace = await this.deps.workspace.resolveCurrent();
        if (!workspace.isGit) throw new Error("a managed worktree requires a git workspace");
        const name = input.worktreeName ?? this.deps.paneName;
        const created = await this.deps.worktrees.create(workspace, name);
        if (!created.worktreePath) throw new Error("managed shell worktree path is missing");
        worktree = {
          name,
          workspaceRoot: workspace.rootPath,
          worktreeRoot: created.worktreeRoot ?? null,
          worktreePath: created.worktreePath,
          branch: created.branch ?? null,
          baseCommit: created.baseCommit ?? null,
          setupHook: workspace.setupScriptPath
            ? await this.deps.hooks.resolveHook(workspace.setupScriptPath, workspace.rootPath)
            : null,
          cleanupHook: workspace.cleanupScriptPath
            ? await this.deps.hooks.resolveHook(workspace.cleanupScriptPath, workspace.rootPath)
            : null,
        };
        if (!(await this.deps.worktrees.copyFiles(worktree, workspace.worktreeCopyPatterns))) {
          throw new Error("worktree file copy failed");
        }
        if (
          !(await this.deps.hooks.runShell({
            ...worktree,
            hook: worktree.setupHook,
            kind: "setup",
            runDir: worktree.worktreePath,
          }))
        ) {
          throw new Error("setup hook failed");
        }
        shellCwd = worktree.worktreePath;
      }
      const shell = input.shell ?? "sh";
      return {
        process: await this.deps.process.run({ executable: shell, args: ["-i"], cwd: shellCwd, interactive: true }),
      };
    } finally {
      try {
        if (worktree) {
          await this.deps.hooks.runShell({
            ...worktree,
            hook: worktree.cleanupHook,
            kind: "cleanup",
            runDir: worktree.worktreePath,
          });
          await this.deps.worktrees.remove(worktree);
        }
      } finally {
        this.deps.panes.restoreShell();
      }
    }
  }
}
