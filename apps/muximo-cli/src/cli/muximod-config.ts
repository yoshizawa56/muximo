import type { DaemonOptions } from "@muximo/application";
import {
  allowedRootsFromEnvironment,
  defaultLogFile,
  parseLogLevel,
  resolveMuximodPaths,
  validateMuximodControlSocketPath,
} from "@muximo/infrastructure";
import type { MuximodConfig } from "@muximo/muximod";

export type MuximodConfigResolverOptions = {
  environment: NodeJS.ProcessEnv;
  workingDirectory: string;
  databaseFile?: string;
};

/** Resolves process configuration at the CLI boundary before DI enters muximod. */
export function createMuximodConfigResolver(
  options: MuximodConfigResolverOptions,
): (daemon: DaemonOptions) => MuximodConfig {
  return (daemon) => {
    const paths = resolveMuximodPaths(options.environment, {
      databaseFile: options.databaseFile,
      pidFile: daemon.pidFile,
      controlSocket: daemon.controlSocket,
    });
    validateMuximodControlSocketPath(paths.controlSocket);

    const logLevel = daemon.logLevel ?? parseLogLevel(options.environment.MUXIMO_LOG_LEVEL, "info");
    const logFile = daemon.logFile ?? defaultLogFile(options.environment);
    const muximodBaseUrl = daemon.muximodBaseUrl ?? localMuximodUrl(daemon.host, daemon.port);
    const allowedOrigins = daemon.allowedOrigins ?? readOrigins(options.environment.MUXIMOD_ALLOWED_ORIGINS);

    return {
      host: daemon.host,
      port: daemon.port,
      instanceDirectory: paths.instanceDirectory,
      databaseFile: paths.databaseFile,
      hookOutputDirectory: paths.hookOutputDirectory,
      pidFile: paths.pidFile,
      controlSocket: paths.controlSocket,
      muximodBaseUrl,
      allowedOrigins: [...allowedOrigins],
      allowedRoots: allowedRootsFromEnvironment(options.environment, options.workingDirectory),
      logLevel,
      ...(logFile ? { logFile } : {}),
      workingDirectory: options.workingDirectory,
      authSweepIntervalMs: readDuration(options.environment.MUXIMOD_AUTH_SWEEP_INTERVAL_MS, 1),
      tmuxPollIntervalMs: readDuration(options.environment.MUXIMOD_TMUX_POLL_INTERVAL_MS, 1),
      paneCleanupIntervalMs: readDuration(options.environment.MUXIMOD_PANE_CLEANUP_INTERVAL_MS, 1),
      paneRetentionMs: readDuration(options.environment.MUXIMOD_PANE_RETENTION_MS, 0),
    };
  };
}

function readOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function readDuration(value: string | undefined, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`duration must be an integer >= ${minimum}`);
  }
  return parsed;
}

function localMuximodUrl(host: string, port: number): string {
  const normalizedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const formattedHost =
    normalizedHost.includes(":") && !normalizedHost.startsWith("[") ? `[${normalizedHost}]` : normalizedHost;
  return `http://${formattedHost}:${port}`;
}
