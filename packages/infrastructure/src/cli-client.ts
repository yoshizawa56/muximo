/** Host capabilities that may be used by the CLI client composition root. */

export { AttachedAgentExecutionAdapter, type AttachedAgentExecutionLogger } from "./cli/agent-execution.js";
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
  listIgnoredFiles,
  listUnmanagedFiles,
} from "./cli/git.js";
export * from "./cli/hooks.js";
export { TmuxPanePublicationAdapter } from "./cli/pane.js";
export {
  ensureTailscaleServe,
  localMuximodUrl,
  normalizeAllowedOrigins,
  type ServeCommandDependencies,
  type ServeCommandOptions,
  type ServeInput,
  type TailscaleServeResult,
} from "./cli/serve.js";
export * from "./cli/shell.js";
export * from "./cli/tmux-session.js";
export { GitShellWorktreeAdapter, GitWorktreeAdapter, type WorktreeAdapterOptions } from "./cli/worktree.js";
export { createLogger, type Logger, type LogLevel, parseLogLevel } from "./logging/index.js";
export { sanitizeProcessDiagnostic } from "./process/process.js";
export {
  buildServeArgs,
  buildServeHttpUrl,
  buildServeStopArgs,
  buildTailscaleInvocation,
  createTailscaleServeClient,
  fingerprintRoute,
  hasTailscaleServeRoute,
  parseTailscaleHostname,
  readServeRouteState,
  removeServeRouteState,
  type ServeRouteState,
  type TailscaleCommandResult,
  type TailscaleCommandRunner,
  type TailscaleServeClient,
  type TailscaleServeClientOptions,
  type TailscaleServeRoute,
  type TailscaleServeRouteIdentity,
  writeServeRouteState,
} from "./tailscale/index.js";
export {
  buildMuximoShellCommand,
  configureManagedTmuxSession,
  resolveMuximoCommand,
  TmuxAdapter,
} from "./terminal/tmux.js";
export { workspaceIdForPath } from "./workspace/selection.js";
