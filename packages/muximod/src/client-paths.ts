import { resolve } from "node:path";
import { defaultMuximodInstanceDirectory, type InstancePaths, resolveInstancePaths } from "@muximo/instance-contract";

export { defaultMuximodInstanceDirectory } from "@muximo/instance-contract";

export type MuximodClientPaths = Pick<
  InstancePaths,
  "instanceDirectory" | "hookOutputDirectory" | "pidFile" | "controlSocket"
>;

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
  const configuredInstanceDirectory = nonEmptyPath(env.MUXIMOD_INSTANCE_DIR) ?? defaultMuximodInstanceDirectory(env);
  const paths = resolveInstancePaths(resolve(baseDirectory, configuredInstanceDirectory));
  return {
    instanceDirectory: paths.instanceDirectory,
    hookOutputDirectory: paths.hookOutputDirectory,
    pidFile: paths.pidFile,
    controlSocket: paths.controlSocket,
  };
}

export function validateMuximodControlSocketPath(path: string): void {
  const bytes = Buffer.byteLength(path);
  if (bytes > muximodControlSocketMaxBytes) {
    throw new Error(
      `muximod control socket path is too long (${bytes} bytes; maximum ${muximodControlSocketMaxBytes}): ${path}`,
    );
  }
}

function nonEmptyPath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
