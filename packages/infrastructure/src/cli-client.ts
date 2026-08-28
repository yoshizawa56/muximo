/** Host capabilities that may be used by the CLI client composition root. */

export * from "./cli/dev.js";
export * from "./cli/doctor.js";
export {
  isPathWithin,
  realpathAfterMkdir,
  realpathSafe,
  resolveFromRoot,
  unlinkEmptyDirectory,
} from "./cli/filesystem.js";
export {
  gitOutputMaxBuffer,
  gitOutputOrEmpty,
  gitOutputRaw,
  gitRequired,
  gitStatus,
  gitStatusCode,
  gitWorkspaceRoot,
  listUnmanagedFiles,
} from "./cli/git.js";
export * from "./cli/hooks.js";
export { TmuxPanePublicationAdapter } from "./cli/pane.js";
export {
  ensureTailscaleServe,
  localMuximodUrl,
  normalizeAllowedOrigins,
  resolvePairingBaseUrl,
  resolveServeAllowedOrigins,
  resolveServeLogOptions,
  type ServeCommandDependencies,
  type ServeCommandOptions,
  type ServeInput,
  type ServeMuximodLease,
  type ServeProcessHandle,
  type TailscaleServeResult,
} from "./cli/serve.js";
export * from "./cli/shell.js";
export * from "./cli/tmux-session.js";
export { GitShellWorktreeAdapter, GitWorktreeAdapter, type WorktreeAdapterOptions } from "./cli/worktree.js";
export { createLogger, defaultLogFile, type Logger, type LogLevel, parseLogLevel } from "./logging/index.js";
export {
  buildMuximoShellCommand,
  configureManagedTmuxSession,
  resolveMuximoCommand,
  TmuxAdapter,
} from "./terminal/tmux.js";
export { allowedRootsFromEnvironment, workspaceIdForPath } from "./workspace/selection.js";
