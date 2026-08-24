import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type MuximodInstancePaths = {
  instanceDirectory: string;
  databaseFile: string;
  hookOutputDirectory: string;
  pidFile: string;
  controlSocket: string;
};

export type MuximodPathOverrides = {
  databaseFile?: string;
  hookOutputDirectory?: string;
  pidFile?: string;
  controlSocket?: string;
};

export const muximodControlSocketMaxBytes = 103;

/**
 * Resolve the filesystem paths owned by one muximod instance.
 *
 * MUXIMOD_INSTANCE_DIR is the normal configuration surface. The individual
 * path variables remain supported as advanced and legacy overrides, but an
 * instance directory always supplies deterministic defaults for the paths
 * that were not overridden explicitly.
 */
export function resolveMuximodPaths(
  env: NodeJS.ProcessEnv = process.env,
  overrides: MuximodPathOverrides = {},
): MuximodInstancePaths {
  const configuredInstanceDirectory = nonEmptyPath(env.MUXIMOD_INSTANCE_DIR);
  const hasConfiguredInstanceDirectory = Boolean(configuredInstanceDirectory);
  const instanceDirectory = resolve(configuredInstanceDirectory ?? defaultMuximodInstanceDirectory(env));
  const configuredDatabaseFile =
    nonEmptyPath(overrides.databaseFile) ?? nonEmptyPath(env.MUXIMOD_DB_FILE) ?? nonEmptyPath(env.MUXIMO_DATABASE_FILE);
  const databaseFile = resolveDatabaseFile(configuredDatabaseFile ?? join(instanceDirectory, "muximod.sqlite"));
  const hookOutputDirectory = resolvePath(
    nonEmptyPath(overrides.hookOutputDirectory) ??
      nonEmptyPath(env.MUXIMO_HOOK_OUTPUT_DIR) ??
      join(instanceDirectory, "hooks"),
  );
  const pidFile = resolvePath(
    nonEmptyPath(overrides.pidFile) ??
      nonEmptyPath(env.MUXIMOD_PID_FILE) ??
      (hasConfiguredInstanceDirectory
        ? defaultPidFile(instanceDirectory, databaseFile)
        : legacyPidFile(databaseFile, instanceDirectory)),
  );
  const controlSocket = resolvePath(
    nonEmptyPath(overrides.controlSocket) ??
      nonEmptyPath(env.MUXIMOD_CONTROL_SOCKET) ??
      (hasConfiguredInstanceDirectory
        ? defaultControlSocket(instanceDirectory)
        : legacyControlSocket(databaseFile, instanceDirectory)),
  );

  return { instanceDirectory, databaseFile, hookOutputDirectory, pidFile, controlSocket };
}

export function defaultMuximodInstanceDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".local", "state", "muximo");
}

export function validateMuximodControlSocketPath(path: string): void {
  const bytes = Buffer.byteLength(path);
  if (bytes > muximodControlSocketMaxBytes) {
    throw new Error(
      `muximod control socket path is too long (${bytes} bytes; maximum ${muximodControlSocketMaxBytes}): ${path}`,
    );
  }
}

function defaultPidFile(instanceDirectory: string, databaseFile: string): string {
  return databaseFile === ":memory:"
    ? join(instanceDirectory, "muximod.pid")
    : join(instanceDirectory, "muximod.sqlite.pid");
}

function defaultControlSocket(instanceDirectory: string): string {
  return join(instanceDirectory, "muximod.sock");
}

function legacyPidFile(databaseFile: string, instanceDirectory: string): string {
  return databaseFile === ":memory:" ? join(instanceDirectory, "muximod.pid") : `${databaseFile}.pid`;
}

function legacyControlSocket(databaseFile: string, instanceDirectory: string): string {
  return databaseFile === ":memory:" ? join(instanceDirectory, "muximod.control.sock") : `${databaseFile}.control.sock`;
}

function resolveDatabaseFile(value: string): string {
  return value === ":memory:" ? value : resolve(value);
}

function resolvePath(value: string): string {
  return resolve(value);
}

function nonEmptyPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
