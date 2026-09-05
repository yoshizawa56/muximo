import type { Workspace, WorkspaceDirectoryOption } from "@muximo/domain";
import { Context, Layer } from "effect";
import type { ApplicationEffect } from "../../effect.js";
import type { ProcessResult } from "../../ports/agent-sessions.js";
import type { ShellProcessInput, ShellWorktree, ShellWorktreeAllocation } from "../../ports/shell.js";

export interface ShellProcess {
  run(input: ShellProcessInput): ApplicationEffect<ProcessResult>;
}

export interface ShellWorktreeOperations {
  create(workspace: WorkspaceDirectoryOption, name: string): ApplicationEffect<ShellWorktreeAllocation>;
  copyFiles(target: Pick<ShellWorktree, "workspaceRoot" | "worktreePath">): ApplicationEffect<boolean>;
  remove(input: ShellWorktree): ApplicationEffect<boolean>;
}

export interface ShellHook {
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

export interface ShellPane {
  markShell(name: string): void;
  restoreShell(): void;
}

export interface ShellWorkspaceResolver {
  resolveCurrent(): ApplicationEffect<WorkspaceDirectoryOption>;
}

export interface SessionWorktreeLookup {
  findWorktreePath(workspaceId: Workspace["id"], sessionName: string, fallbackCwd: string): ApplicationEffect<string>;
}

/** Shell process capability. */
export class ShellProcessService extends Context.Service<ShellProcessService, ShellProcess>()(
  "@muximo/application/ShellProcess",
) {}

/** Shell Git worktree capability. */
export class ShellWorktreeService extends Context.Service<ShellWorktreeService, ShellWorktreeOperations>()(
  "@muximo/application/ShellWorktree",
) {}

/** Shell hook capability. */
export class ShellHookService extends Context.Service<ShellHookService, ShellHook>()("@muximo/application/ShellHook") {}

/** Shell pane metadata capability. */
export class ShellPaneService extends Context.Service<ShellPaneService, ShellPane>()("@muximo/application/ShellPane") {}

/** Current-workspace resolution capability for the host shell. */
export class ShellWorkspaceResolverService extends Context.Service<
  ShellWorkspaceResolverService,
  ShellWorkspaceResolver
>()("@muximo/application/ShellWorkspaceResolver") {}

/** Session worktree lookup capability for the host shell. */
export class SessionWorktreeLookupService extends Context.Service<
  SessionWorktreeLookupService,
  SessionWorktreeLookup
>()("@muximo/application/SessionWorktreeLookup") {}

/** Host configuration required by the shell workflow. */
export type ShellContext = {
  cwd: string;
  paneName: string;
  defaultShell: string;
};

/** Host shell configuration supplied by the composition root. */
export class ShellContextService extends Context.Service<ShellContextService, ShellContext>()(
  "@muximo/application/ShellContext",
) {}

/** Services required by the shell workflow. */
export type ShellServices =
  | ShellProcessService
  | ShellWorktreeService
  | ShellHookService
  | ShellPaneService
  | ShellWorkspaceResolverService
  | SessionWorktreeLookupService
  | ShellContextService;

export const shellProcessLayer = (process: ShellProcess): Layer.Layer<ShellProcessService> =>
  Layer.succeed(ShellProcessService, process);

export const shellWorktreeLayer = (worktrees: ShellWorktreeOperations): Layer.Layer<ShellWorktreeService> =>
  Layer.succeed(ShellWorktreeService, worktrees);

export const shellHookLayer = (hooks: ShellHook): Layer.Layer<ShellHookService> =>
  Layer.succeed(ShellHookService, hooks);

export const shellPaneLayer = (panes: ShellPane): Layer.Layer<ShellPaneService> =>
  Layer.succeed(ShellPaneService, panes);

export const shellWorkspaceResolverLayer = (
  workspace: ShellWorkspaceResolver,
): Layer.Layer<ShellWorkspaceResolverService> => Layer.succeed(ShellWorkspaceResolverService, workspace);

export const sessionWorktreeLookupLayer = (
  sessions: SessionWorktreeLookup,
): Layer.Layer<SessionWorktreeLookupService> => Layer.succeed(SessionWorktreeLookupService, sessions);

export const shellContextLayer = (context: ShellContext): Layer.Layer<ShellContextService> =>
  Layer.succeed(ShellContextService, context);

/** Assembles shell services from concrete implementations and host settings. */
export const shellLayer = (dependencies: {
  context: ShellContext;
  workspace: ShellWorkspaceResolver;
  sessions: SessionWorktreeLookup;
  process: ShellProcess;
  worktrees: ShellWorktreeOperations;
  hooks: ShellHook;
  panes: ShellPane;
}): Layer.Layer<ShellServices> =>
  Layer.mergeAll(
    shellContextLayer(dependencies.context),
    shellWorkspaceResolverLayer(dependencies.workspace),
    sessionWorktreeLookupLayer(dependencies.sessions),
    shellProcessLayer(dependencies.process),
    shellWorktreeLayer(dependencies.worktrees),
    shellHookLayer(dependencies.hooks),
    shellPaneLayer(dependencies.panes),
  );
