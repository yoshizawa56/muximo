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
  hookOutputDirectory?: string;
  pidFile?: string;
  controlSocket?: string;
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
  const hookOutputDirectory = resolvePath(
    nonEmptyPath(overrides.hookOutputDirectory) ??
      nonEmptyPath(env.MUXIMO_HOOK_OUTPUT_DIR) ??
      join(instanceDirectory, "hooks"),
    baseDirectory,
  );
  const pidFile = resolvePath(
    nonEmptyPath(overrides.pidFile) ??
      nonEmptyPath(env.MUXIMOD_PID_FILE) ??
      join(instanceDirectory, "muximod.sqlite.pid"),
    baseDirectory,
  );
  const controlSocket = resolvePath(
    nonEmptyPath(overrides.controlSocket) ??
      nonEmptyPath(env.MUXIMOD_CONTROL_SOCKET) ??
      join(instanceDirectory, "muximod.sock"),
    baseDirectory,
  );

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
