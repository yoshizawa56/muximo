import type { WorkspaceDirectoryOption } from "@muximo/domain";
import { Effect } from "effect";
import type { ProcessResult } from "../../ports/agent-sessions.js";
import { ApplicationFailure } from "../../ports/application.js";
import type { RunShellDependencies, RunShellInput, ShellWorktree, ShellWorktreeAllocation } from "../../ports/shell.js";

export type RunShellResult = {
  process: ProcessResult;
};

type ShellWorkspace = WorkspaceDirectoryOption;
type ShellWorktreeLease = {
  readonly allocation: ShellWorktreeAllocation;
  readonly workspace: ShellWorkspace;
  readonly name: string;
  cleanupHook: string | null;
  worktree?: ShellWorktree;
};

/** Application workflow for an interactive shell and its optional managed worktree. */
export class RunShell {
  public constructor(private readonly deps: RunShellDependencies) {}

  public readonly execute = Effect.fn("Shell.run")({ self: this }, function* (this: RunShell, input: RunShellInput) {
    yield* Effect.sync(() => this.deps.panes.markShell(this.deps.paneName));
    return yield* Effect.ensuring(
      this.runWorkflow(input),
      Effect.sync(() => this.deps.panes.restoreShell()),
    );
  });

  private runWorkflow(input: RunShellInput): Effect.Effect<RunShellResult, Error, never> {
    const deps = this.deps;
    return Effect.gen(function* () {
      let shellCwd = deps.cwd;
      if (input.command.length > 0) {
        const executable = input.command[0];
        if (!executable)
          return yield* Effect.fail(
            new ApplicationFailure("shell_command_executable_missing", "shell command executable is missing"),
          );
        const result = yield* deps.process.run({
          executable,
          args: input.command.slice(1),
          cwd: deps.cwd,
          interactive: false,
        });
        if (input.exitAfterCommand) return { process: result };
        const workspace = yield* deps.workspace.resolveCurrent();
        shellCwd = yield* deps.sessions.findWorktreePath(workspace.id, deps.paneName, deps.cwd);
      }

      if (!input.worktree) return yield* runInteractiveShell(deps, input, shellCwd);

      const workspace = yield* deps.workspace.resolveCurrent();
      if (!workspace.isGit)
        return yield* Effect.fail(
          new ApplicationFailure("managed_worktree_requires_git", "a managed worktree requires a git workspace"),
        );
      const name = input.worktreeName ?? deps.paneName;

      return yield* Effect.acquireUseRelease(
        Effect.map(
          deps.worktrees.create(workspace, name),
          (allocation) =>
            ({
              allocation,
              workspace,
              name,
              cleanupHook: null,
            }) satisfies ShellWorktreeLease,
        ),
        (lease) => useShellWorktree(deps, lease, input),
        (lease) => releaseShellWorktree(deps, lease),
      );
    });
  }
}

function useShellWorktree(
  deps: RunShellDependencies,
  lease: ShellWorktreeLease,
  input: RunShellInput,
): Effect.Effect<RunShellResult, Error, never> {
  return Effect.gen(function* () {
    const setupScriptPath = lease.workspace.setupScriptPath;
    const cleanupScriptPath = lease.workspace.cleanupScriptPath;
    const worktree: ShellWorktree = {
      name: lease.name,
      workspaceRoot: lease.workspace.rootPath,
      worktreeRoot: lease.allocation.worktreeRoot,
      worktreePath: lease.allocation.worktreePath,
      branch: lease.allocation.branch,
      baseCommit: lease.allocation.baseCommit,
      setupHook: setupScriptPath ? yield* deps.hooks.resolveHook(setupScriptPath, lease.workspace.rootPath) : null,
      cleanupHook: cleanupScriptPath
        ? yield* deps.hooks.resolveHook(cleanupScriptPath, lease.workspace.rootPath)
        : null,
    };
    lease.worktree = worktree;
    lease.cleanupHook = worktree.cleanupHook;

    if (!(yield* deps.worktrees.copyFiles(worktree))) {
      return yield* Effect.fail(new ApplicationFailure("worktree_file_copy_failed", "worktree file copy failed"));
    }
    if (
      !(yield* deps.hooks.runShell({
        ...worktree,
        hook: worktree.setupHook,
        kind: "setup",
        runDir: worktree.worktreePath,
      }))
    ) {
      return yield* Effect.fail(new ApplicationFailure("setup_hook_failed", "setup hook failed"));
    }
    return yield* runInteractiveShell(deps, input, worktree.worktreePath);
  });
}

function releaseShellWorktree(
  deps: RunShellDependencies,
  lease: ShellWorktreeLease,
): Effect.Effect<void, Error, never> {
  const worktree: ShellWorktree = lease.worktree ?? {
    name: lease.name,
    workspaceRoot: lease.workspace.rootPath,
    worktreeRoot: lease.allocation.worktreeRoot,
    worktreePath: lease.allocation.worktreePath,
    branch: lease.allocation.branch,
    baseCommit: lease.allocation.baseCommit,
    setupHook: null,
    cleanupHook: lease.cleanupHook,
  };
  return Effect.gen(function* () {
    const cleanup = yield* Effect.result(
      deps.hooks.runShell({
        ...worktree,
        hook: worktree.cleanupHook,
        kind: "cleanup",
        runDir: worktree.worktreePath,
      }),
    );
    const removal = yield* Effect.result(deps.worktrees.remove(worktree));
    if (removal._tag === "Failure") return yield* Effect.fail(removal.failure);
    if (!removal.success)
      return yield* Effect.fail(
        new ApplicationFailure("managed_shell_worktree_retained", "managed shell worktree was retained"),
      );
    if (cleanup._tag === "Failure") return yield* Effect.fail(cleanup.failure);
    if (!cleanup.success)
      return yield* Effect.fail(new ApplicationFailure("cleanup_hook_failed", "cleanup hook failed"));
  });
}

function runInteractiveShell(
  deps: RunShellDependencies,
  input: RunShellInput,
  cwd: string,
): Effect.Effect<RunShellResult, Error, never> {
  const shell = input.shell ?? deps.defaultShell;
  return Effect.map(
    deps.process.run({
      executable: shell,
      args: ["-l", "-i"],
      cwd,
      interactive: true,
    }),
    (process) => ({ process }),
  );
}
