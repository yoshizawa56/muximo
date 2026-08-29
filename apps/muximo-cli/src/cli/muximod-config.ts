import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { DaemonOptions } from "@muximo/application";
import {
  allowedRootsFromEnvironment,
  defaultLogFile,
  normalizeAllowedOrigins,
  parseLogLevel,
} from "@muximo/infrastructure/cli-client";
import {
  type MuximodConfig,
  resolveMuximodClientPaths,
  validateMuximodControlSocketPath,
} from "@muximo/muximod/client";

export type MuximodConfigResolverOptions = {
  environment: NodeJS.ProcessEnv;
  workingDirectory: string;
};

/** Resolves process configuration at the CLI boundary before DI enters muximod. */
export function createMuximodConfigResolver(
  options: MuximodConfigResolverOptions,
): (daemon: DaemonOptions) => MuximodConfig {
  return (daemon) => {
    const workingDirectory = resolve(options.workingDirectory);
    const paths = resolveMuximodClientPaths(options.environment, { baseDirectory: workingDirectory });
    validateMuximodControlSocketPath(paths.controlSocket);

    const logLevel = daemon.logLevel ?? parseLogLevel(options.environment.MUXIMO_LOG_LEVEL, "info");
    const configuredLogFile = daemon.logFile ?? options.environment.MUXIMO_LOG_FILE;
    const logFile = configuredLogFile
      ? resolveConfiguredPath(configuredLogFile, options.workingDirectory)
      : defaultLogFile(options.environment);
    const allowedOrigins = normalizeAllowedOrigins(
      daemon.allowedOrigins ?? readOrigins(options.environment.MUXIMOD_ALLOWED_ORIGINS),
    );
    return {
      host: daemon.host,
      port: daemon.port,
      instanceDirectory: paths.instanceDirectory,
      hookOutputDirectory: paths.hookOutputDirectory,
      pidFile: paths.pidFile,
      controlSocket: paths.controlSocket,
      allowedOrigins: [...allowedOrigins],
      allowedRoots: allowedRootsFromEnvironment(options.environment, workingDirectory).map((root) =>
        resolveConfiguredPath(root, workingDirectory),
      ),
      logLevel,
      ...(logFile ? { logFile } : {}),
      workingDirectory,
      runtimeEnvironment: resolveRuntimeEnvironment(options.environment, workingDirectory),
      authSweepIntervalMs: readDuration(options.environment.MUXIMOD_AUTH_SWEEP_INTERVAL_MS, 1),
      tmuxPollIntervalMs: readDuration(options.environment.MUXIMOD_TMUX_POLL_INTERVAL_MS, 1),
      paneCleanupIntervalMs: readDuration(options.environment.MUXIMOD_PANE_CLEANUP_INTERVAL_MS, 1),
      paneRetentionMs: readDuration(options.environment.MUXIMOD_PANE_RETENTION_MS, 0),
    };
  };
}

function resolveRuntimeEnvironment(environment: NodeJS.ProcessEnv, workingDirectory: string) {
  return {
    homeDirectory: readEnvironmentValue(environment.HOME),
    path: readEnvironmentValue(environment.PATH),
    codexHome: readEnvironmentValue(environment.CODEX_HOME),
    claudeConfigDirectory: readEnvironmentValue(environment.CLAUDE_CONFIG_DIR),
    tailscaleBinary: readEnvironmentValue(environment.TAILSCALE_BIN),
    tmuxPane: readEnvironmentValue(environment.TMUX_PANE),
    tmuxSocket: readEnvironmentValue(environment.MUXIMOD_TMUX_SOCKET),
    worktreeId: readEnvironmentValue(environment.MUXIMO_WORKTREE_ID),
    worktreeRoot: readEnvironmentValue(environment.MUXIMO_WORKTREE_ROOT),
    muximoCommand: readEnvironmentValue(environment.MUXIMOD_MUXIMO_COMMAND),
    codexRemote: readEnvironmentValue(environment.MUXIMO_CODEX_REMOTE) ?? "unix://",
    codexBinary: readEnvironmentValue(environment.MUXIMO_CODEX_BIN),
    claudeBinary: readEnvironmentValue(environment.MUXIMO_CLAUDE_BIN),
    opencodeBinary: readEnvironmentValue(environment.MUXIMO_OPENCODE_BIN),
    migrationsDirectory: environment.MUXIMOD_MIGRATIONS_DIR
      ? resolveConfiguredPath(environment.MUXIMOD_MIGRATIONS_DIR, workingDirectory)
      : null,
  };
}

function readEnvironmentValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function resolveConfiguredPath(value: string, baseDirectory: string): string {
  const expanded = value === "~" ? homedir() : value.startsWith("~/") ? resolve(homedir(), value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : resolve(baseDirectory, expanded));
}

function readOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return normalizeAllowedOrigins(value.split(","));
}

function readDuration(value: string | undefined, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`duration must be an integer >= ${minimum}`);
  }
  return parsed;
}
