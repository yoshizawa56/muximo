import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type MuximoEnvironmentName,
  type MuximoEnvironmentProfile,
  parseDotEnv,
  profileFilePath,
  resolveMuximoEnvironmentProfile as resolveProfile,
} from "@muximo/environment";

export { type MuximoEnvironmentName, type MuximoEnvironmentProfile, muximoEnvironmentNames } from "@muximo/environment";

export type ResolveMuximoEnvironmentProfileOptions = {
  name: MuximoEnvironmentName;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  repositoryRoot?: string;
};

/** Application boundary: reads process input and the selected profile file. */
export function resolveMuximoEnvironmentProfile(
  options: ResolveMuximoEnvironmentProfileOptions,
): MuximoEnvironmentProfile {
  const cwd = resolve(options.cwd ?? process.cwd());
  const environment = options.environment ?? process.env;
  const repositoryRoot = options.repositoryRoot ?? findRepositoryRoot(cwd);
  return resolveProfile({
    name: options.name,
    cwd,
    homeDirectory: environment.HOME ?? homedir(),
    environment,
    profileValues: loadProfileValues(options.name, repositoryRoot),
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
  });
}

function loadProfileValues(name: MuximoEnvironmentName, repositoryRoot: string | undefined): Record<string, string> {
  if (name === "prod") return {};
  if (repositoryRoot === undefined) {
    throw new Error(`the ${name} environment requires a source checkout containing .env.${name}`);
  }
  const path = profileFilePath(name, repositoryRoot);
  if (!existsSync(path)) {
    throw new Error(`the ${name} environment profile was not found: ${path}`);
  }
  try {
    return parseDotEnv(readFileSync(path, "utf8"), path);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`${path}:`)) throw error;
    throw new Error(`could not read environment profile ${path}`, { cause: error });
  }
}

function findRepositoryRoot(startDirectory: string): string | undefined {
  let current = startDirectory;
  while (true) {
    if (existsSync(join(current, "package.json")) && existsSync(join(current, "apps"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
