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
};

/**
 * Resolve the filesystem paths owned by one muximod instance.
 *
 * MUXIMOD_INSTANCE_DIR is the only runtime path configuration surface.
 * Individual daemon files are derived from the instance directory so every
 * client and daemon composition resolves the same ownership boundary.
 */
export function resolveMuximodPaths(
  env: NodeJS.ProcessEnv = process.env,
  overrides: MuximodPathOverrides = {},
): MuximodInstancePaths {
  const configuredInstanceDirectory = nonEmptyPath(env.MUXIMOD_INSTANCE_DIR);
  const instanceDirectory = resolve(configuredInstanceDirectory ?? defaultMuximodInstanceDirectory(env));
  const configuredDatabaseFile = nonEmptyPath(overrides.databaseFile);
  const databaseFile = resolveDatabaseFile(configuredDatabaseFile ?? join(instanceDirectory, "muximod.sqlite"));
  const hookOutputDirectory = join(instanceDirectory, "hooks");
  const pidFile = join(instanceDirectory, "muximod.pid");
  const controlSocket = join(instanceDirectory, "muximod.sock");

  return { instanceDirectory, databaseFile, hookOutputDirectory, pidFile, controlSocket };
}

export function defaultMuximodInstanceDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".local", "state", "muximo");
}

function resolveDatabaseFile(value: string): string {
  return value === ":memory:" ? value : resolve(value);
}

function nonEmptyPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
