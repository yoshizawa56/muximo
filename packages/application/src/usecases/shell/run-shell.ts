import type { WorkspaceDirectoryOption } from "@muximo/domain";
import { Effect } from "effect";
import type { ProcessResult } from "../../ports/agent-sessions.js";
import { ApplicationFailure } from "../../ports/application.js";
import type { RunShellInput, ShellWorktree, ShellWorktreeAllocation } from "../../ports/shell.js";
import type { ShellServices } from "./shell-services.js";
import {
  SessionWorktreeLookupService,
  ShellContextService,
  ShellHookService,
  ShellPaneService,
  ShellProcessService,
  ShellWorkspaceResolverService,
  ShellWorktreeService,
} from "./shell-services.js";

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
  public readonly execute = Effect.fn("Shell.run")({ self: this }, function* (this: RunShell, input: RunShellInput) {
    const context = yield* ShellContextService;
    const panes = yield* ShellPaneService;
    yield* Effect.sync(() => panes.markShell(context.paneName));
    return yield* Effect.ensuring(
      this.runWorkflow(input),
      Effect.sync(() => panes.restoreShell()),
    );
  });

  private runWorkflow(input: RunShellInput): Effect.Effect<RunShellResult, Error, ShellServices> {
    return Effect.gen(function* () {
      const context = yield* ShellContextService;
      const workspaceResolver = yield* ShellWorkspaceResolverService;
      const sessionLookup = yield* SessionWorktreeLookupService;
      const process = yield* ShellProcessService;
      const worktrees = yield* ShellWorktreeService;
      let shellCwd = context.cwd;
      if (input.command.length > 0) {
        const executable = input.command[0];
        if (!executable)
          return yield* Effect.fail(
            new ApplicationFailure("shell_command_executable_missing", "shell command executable is missing"),
          );
        const result = yield* process.run({
          executable,
          args: input.command.slice(1),
          cwd: context.cwd,
          interactive: false,
        });
        if (input.exitAfterCommand) return { process: result };
        const workspace = yield* workspaceResolver.resolveCurrent();
        shellCwd = yield* sessionLookup.findWorktreePath(workspace.id, context.paneName, context.cwd);
      }

      if (!input.worktree) return yield* runInteractiveShell(input, shellCwd, context.defaultShell);

      const workspace = yield* workspaceResolver.resolveCurrent();
      if (!workspace.isGit)
        return yield* Effect.fail(
          new ApplicationFailure("managed_worktree_requires_git", "a managed worktree requires a git workspace"),
        );
      const name = input.worktreeName ?? context.paneName;

      return yield* Effect.acquireUseRelease(
        Effect.map(
          worktrees.create(workspace, name),
          (allocation) =>
            ({
              allocation,
              workspace,
              name,
              cleanupHook: null,
            }) satisfies ShellWorktreeLease,
        ),
        (lease) => useShellWorktree(lease, input, context.defaultShell),
        (lease) => releaseShellWorktree(lease),
      );
    });
  }
}

function useShellWorktree(
  lease: ShellWorktreeLease,
  input: RunShellInput,
  defaultShell: string,
): Effect.Effect<RunShellResult, Error, ShellServices> {
  return Effect.gen(function* () {
    const hooks = yield* ShellHookService;
    const worktrees = yield* ShellWorktreeService;
    const setupScriptPath = lease.workspace.setupScriptPath;
    const cleanupScriptPath = lease.workspace.cleanupScriptPath;
    const worktree: ShellWorktree = {
      name: lease.name,
      workspaceRoot: lease.workspace.rootPath,
      worktreeRoot: lease.allocation.worktreeRoot,
      worktreePath: lease.allocation.worktreePath,
      branch: lease.allocation.branch,
      baseCommit: lease.allocation.baseCommit,
      setupHook: setupScriptPath ? yield* hooks.resolveHook(setupScriptPath, lease.workspace.rootPath) : null,
      cleanupHook: cleanupScriptPath ? yield* hooks.resolveHook(cleanupScriptPath, lease.workspace.rootPath) : null,
    };
    lease.worktree = worktree;
    lease.cleanupHook = worktree.cleanupHook;

    if (!(yield* worktrees.copyFiles(worktree))) {
      return yield* Effect.fail(new ApplicationFailure("worktree_file_copy_failed", "worktree file copy failed"));
    }
    if (
      !(yield* hooks.runShell({
        ...worktree,
        hook: worktree.setupHook,
        kind: "setup",
        runDir: worktree.worktreePath,
      }))
    ) {
      return yield* Effect.fail(new ApplicationFailure("setup_hook_failed", "setup hook failed"));
    }
    return yield* runInteractiveShell(input, worktree.worktreePath, defaultShell);
  });
}

function releaseShellWorktree(lease: ShellWorktreeLease): Effect.Effect<void, Error, ShellServices> {
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
    const hooks = yield* ShellHookService;
    const worktrees = yield* ShellWorktreeService;
    const cleanup = yield* Effect.result(
      hooks.runShell({
        ...worktree,
        hook: worktree.cleanupHook,
        kind: "cleanup",
        runDir: worktree.worktreePath,
      }),
    );
    const removal = yield* Effect.result(worktrees.remove(worktree));
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
  input: RunShellInput,
  cwd: string,
  defaultShell: string,
): Effect.Effect<RunShellResult, Error, ShellServices> {
  const shell = input.shell ?? defaultShell;
  return Effect.gen(function* () {
    const process = yield* ShellProcessService;
    return { process: yield* process.run({ executable: shell, args: ["-l", "-i"], cwd, interactive: true }) };
  });
}
