import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";

/** Raw environment values supplied by an application entrypoint or profile file. */
export type EnvironmentValues = Record<string, string | undefined>;

export type ProfileName = string;

/** A profile after generic file loading, before application-specific interpretation. */
export type Profile = {
  name?: ProfileName;
  repositoryRoot?: string;
  sourceFile?: string;
  environment: EnvironmentValues;
};

export type GetProfileOptions = {
  name?: ProfileName;
  cwd: string;
  baseEnvironment?: EnvironmentValues;
  repositoryRoot?: string;
};

/**
 * Loads a selected profile without interpreting component-specific variables.
 * The caller supplies the ambient environment explicitly so this package has
 * no hidden process-global input. Profile values override ambient values and
 * the selected name is authoritative for MUXIMO_ENV. An omitted name means
 * that no profile file is loaded; the caller owns its application defaults.
 */
export function getProfile(options: GetProfileOptions): Profile {
  const cwd = resolve(options.cwd);
  const repositoryRoot = options.repositoryRoot ?? findRepositoryRoot(cwd);
  const name = resolveProfileName(options.name);
  const loaded = loadProfileValues(name, repositoryRoot);
  const environment = {
    ...(options.baseEnvironment ?? {}),
    ...loaded.values,
    ...(name === undefined ? {} : { MUXIMO_ENV: name }),
  };
  return {
    ...(name === undefined ? {} : { name }),
    ...(repositoryRoot === undefined ? {} : { repositoryRoot }),
    ...(loaded.sourceFile === undefined ? {} : { sourceFile: loaded.sourceFile }),
    environment,
  };
}

export function resolveProfileName(value: unknown): ProfileName | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("--env must be a profile name");
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name) || name === "." || name === "..") {
    throw new Error("--env must contain only letters, numbers, dots, hyphens, or underscores");
  }
  return name;
}

export function parseDotEnv(contents: string, source = ".env"): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [index, originalLine] of contents
    .replace(/^\uFEFF/u, "")
    .split(/\r?\n/u)
    .entries()) {
    const lineNumber = index + 1;
    const line = originalLine.trim();
    if (!line || line.startsWith("#")) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) throw new Error(`${source}:${lineNumber}: expected KEY=VALUE`);
    values[match[1]] = parseDotEnvValue(match[2], source, lineNumber);
  }
  return values;
}

export function profileFilePath(name: ProfileName, repositoryRoot: string): string {
  return join(repositoryRoot, `.env.${name}`);
}

/** Returns whether a component can safely bind without an explicit public bind opt-in. */
export function isLoopbackOrPrivateBindHost(value: string): boolean {
  if (value === "localhost") return true;
  const version = isIP(value);
  if (version === 4) return isLoopbackOrPrivateIpv4(value);
  if (version === 6) return value === "::1" || /^(?:fc|fd)/iu.test(value);
  return false;
}

function isLoopbackOrPrivateIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254)
  );
}

function loadProfileValues(
  name: ProfileName | undefined,
  repositoryRoot: string | undefined,
): { values: Record<string, string>; sourceFile?: string } {
  if (name === undefined) return { values: {} };
  if (repositoryRoot === undefined) {
    throw new Error(`the ${name} environment requires a source checkout containing .env.${name}`);
  }
  const path = profileFilePath(name, repositoryRoot);
  if (!existsSync(path)) {
    throw new Error(`the ${name} environment profile was not found: ${path}`);
  }
  try {
    return { values: parseDotEnv(readFileSync(path, "utf8"), path), sourceFile: path };
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

function parseDotEnvValue(value: string, source: string, lineNumber: number): string {
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) throw new Error(`${source}:${lineNumber}: unterminated quoted value`);
    return value.slice(1, -1).replace(/\\([\\"nrt])/gu, (_match, character: string) => {
      if (character === "n") return "\n";
      if (character === "r") return "\r";
      if (character === "t") return "\t";
      return character;
    });
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new Error(`${source}:${lineNumber}: unterminated quoted value`);
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/u, "").trim();
}
