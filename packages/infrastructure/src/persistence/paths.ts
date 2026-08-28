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

/**
 * Resolve the filesystem paths owned by one muximod instance.
 *
 * MUXIMOD_INSTANCE_DIR is the configuration surface for deterministic runtime
 * paths. Individual paths may be overridden explicitly by the composition
 * root when a process needs an isolated test or service layout.
 */
export function resolveMuximodPaths(
  env: NodeJS.ProcessEnv = process.env,
  overrides: MuximodPathOverrides = {},
): MuximodInstancePaths {
  const configuredInstanceDirectory = nonEmptyPath(env.MUXIMOD_INSTANCE_DIR);
  const instanceDirectory = resolve(configuredInstanceDirectory ?? defaultMuximodInstanceDirectory(env));
  const configuredDatabaseFile = nonEmptyPath(overrides.databaseFile);
  const databaseFile = resolveDatabaseFile(configuredDatabaseFile ?? join(instanceDirectory, "muximod.sqlite"));
  const hookOutputDirectory = resolvePath(
    nonEmptyPath(overrides.hookOutputDirectory) ??
      nonEmptyPath(env.MUXIMO_HOOK_OUTPUT_DIR) ??
      join(instanceDirectory, "hooks"),
  );
  const pidFile = resolvePath(
    nonEmptyPath(overrides.pidFile) ??
      nonEmptyPath(env.MUXIMOD_PID_FILE) ??
      defaultPidFile(instanceDirectory, databaseFile),
  );
  const controlSocket = resolvePath(
    nonEmptyPath(overrides.controlSocket) ??
      nonEmptyPath(env.MUXIMOD_CONTROL_SOCKET) ??
      defaultControlSocket(instanceDirectory),
  );

  return { instanceDirectory, databaseFile, hookOutputDirectory, pidFile, controlSocket };
}

export function defaultMuximodInstanceDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".local", "state", "muximo");
}

function defaultPidFile(instanceDirectory: string, databaseFile: string): string {
  return databaseFile === ":memory:"
    ? join(instanceDirectory, "muximod.pid")
    : join(instanceDirectory, "muximod.sqlite.pid");
}

function defaultControlSocket(instanceDirectory: string): string {
  return join(instanceDirectory, "muximod.sock");
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
