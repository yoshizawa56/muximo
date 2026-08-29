import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type MuximodClientPaths = {
  instanceDirectory: string;
  hookOutputDirectory: string;
  pidFile: string;
  controlSocket: string;
};

export type MuximodClientPathOverrides = {
  baseDirectory?: string;
};

export const muximodControlSocketMaxBytes = 103;

/** Resolves only the paths required to bootstrap and contact one daemon. */
export function resolveMuximodClientPaths(
  env: NodeJS.ProcessEnv = process.env,
  overrides: MuximodClientPathOverrides = {},
): MuximodClientPaths {
  const baseDirectory = resolve(overrides.baseDirectory ?? process.cwd());
  const configuredInstanceDirectory = nonEmptyPath(env.MUXIMOD_INSTANCE_DIR);
  const instanceDirectory = resolvePath(
    configuredInstanceDirectory ?? defaultMuximodInstanceDirectory(env),
    baseDirectory,
  );
  const hookOutputDirectory = join(instanceDirectory, "hooks");
  const pidFile = join(instanceDirectory, "muximod.pid");
  const controlSocket = join(instanceDirectory, "muximod.sock");

  return { instanceDirectory, hookOutputDirectory, pidFile, controlSocket };
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

function resolvePath(value: string, baseDirectory: string): string {
  return resolve(isAbsolute(value) ? value : join(baseDirectory, value));
}

function nonEmptyPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
