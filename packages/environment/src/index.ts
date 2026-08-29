import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";

/** Environment values supplied by an application entrypoint. */
export type EnvironmentValues = Record<string, string | undefined>;

export const muximoEnvironmentNames = ["local", "stg", "prod"] as const;
export type MuximoEnvironmentName = (typeof muximoEnvironmentNames)[number];

export type MuximoEnvironmentProfile = {
  name: MuximoEnvironmentName;
  repositoryRoot?: string;
  stateRoot: string;
  muximodInstanceDirectory: string;
  webInstanceDirectory: string;
  environment: EnvironmentValues;
};

export type ResolveMuximoEnvironmentProfileOptions = {
  name: MuximoEnvironmentName;
  cwd: string;
  homeDirectory: string;
  environment: EnvironmentValues;
  profileValues: EnvironmentValues;
  repositoryRoot?: string;
};

const defaultPorts = {
  muximod: { host: "127.0.0.1", port: 4317, externalPort: 8444 },
  web: { host: "127.0.0.1", port: 5227, externalPort: 8449 },
} as const;

/**
 * Resolves explicit application input into the values consumed by clients.
 * This module has no access to process.env or the filesystem; those inputs
 * are owned and loaded by the application entrypoints.
 */
export function resolveMuximoEnvironmentProfile(
  options: ResolveMuximoEnvironmentProfileOptions,
): MuximoEnvironmentProfile {
  const profileValues = options.name === "prod" ? productionProfileValues() : options.profileValues;
  const environment: EnvironmentValues = {
    ...options.environment,
    ...profileValues,
  };
  const stateRoot = resolveConfiguredPath(
    environment.MUXIMO_STATE_ROOT ?? join(options.homeDirectory, ".local", "state", "muximo"),
    options.cwd,
    options.homeDirectory,
  );
  const environmentRoot = join(stateRoot, options.name);
  const muximodInstanceDirectory = join(environmentRoot, "muximod");
  const webInstanceDirectory = join(environmentRoot, "web");

  const resolvedEnvironment: EnvironmentValues = {
    ...environment,
    MUXIMO_ENV: options.name,
    MUXIMOD_INSTANCE_DIR: muximodInstanceDirectory,
    MUXIMOD_HOST: readBindHost(environment.MUXIMO_MUXIMOD_HOST, defaultPorts.muximod.host, "MUXIMO_MUXIMOD_HOST"),
    MUXIMOD_PORT: readPortValue(environment.MUXIMO_MUXIMOD_PORT, defaultPorts.muximod.port),
    MUXIMO_MUXIMOD_SERVE_PORT: readPortValue(environment.MUXIMO_MUXIMOD_SERVE_PORT, defaultPorts.muximod.externalPort),
    MUXIMO_SCHEMA_MODE: readSchemaMode(environment.MUXIMO_SCHEMA_MODE, options.name),
    MUXIMO_LOG_FILE: join(muximodInstanceDirectory, "muximod.log"),
    MUXIMO_WEB_INSTANCE_DIR: webInstanceDirectory,
    MUXIMO_WEB_HOST: readBindHost(environment.MUXIMO_WEB_HOST, defaultPorts.web.host, "MUXIMO_WEB_HOST"),
    VITE_DEV_HOST: readBindHost(environment.MUXIMO_WEB_HOST, defaultPorts.web.host, "MUXIMO_WEB_HOST"),
    VITE_DEV_PORT: readPortValue(environment.MUXIMO_WEB_PORT, defaultPorts.web.port),
    MUXIMO_WEB_SERVE_PORT: readPortValue(environment.MUXIMO_WEB_SERVE_PORT, defaultPorts.web.externalPort),
  };

  delete resolvedEnvironment.MUXIMO_DEV_STATE_ROOT;
  delete resolvedEnvironment.MUXIMO_WORKTREE_ID;
  delete resolvedEnvironment.MUXIMO_WORKTREE_ROOT;
  delete resolvedEnvironment.BASE_MUXIMOD_INSTANCE_DIR;
  delete resolvedEnvironment.MUXIMOD_PID_FILE;
  delete resolvedEnvironment.MUXIMOD_CONTROL_SOCKET;
  delete resolvedEnvironment.MUXIMO_HOOK_OUTPUT_DIR;
  delete resolvedEnvironment.MUXIMO_SERVE_PORT;

  return {
    name: options.name,
    ...(options.repositoryRoot === undefined ? {} : { repositoryRoot: options.repositoryRoot }),
    stateRoot,
    muximodInstanceDirectory,
    webInstanceDirectory,
    environment: resolvedEnvironment,
  };
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

export function profileFilePath(name: MuximoEnvironmentName, repositoryRoot: string): string {
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

function productionProfileValues(): Record<string, string> {
  return {
    MUXIMO_MUXIMOD_HOST: defaultPorts.muximod.host,
    MUXIMO_MUXIMOD_PORT: String(defaultPorts.muximod.port),
    MUXIMO_MUXIMOD_SERVE_PORT: String(defaultPorts.muximod.externalPort),
    MUXIMO_SCHEMA_MODE: "migrate",
    MUXIMO_WEB_HOST: defaultPorts.web.host,
    MUXIMO_WEB_PORT: String(defaultPorts.web.port),
    MUXIMO_WEB_SERVE_PORT: String(defaultPorts.web.externalPort),
  };
}

function readBindHost(value: string | undefined, fallback: string, variableName: string): string {
  const candidate = readValue(value, fallback);
  const normalized = candidate.startsWith("[") && candidate.endsWith("]") ? candidate.slice(1, -1) : candidate;
  if (isLoopbackOrPrivateBindHost(normalized)) return normalized;
  throw new Error(`${variableName} must be localhost, a loopback address, or a private IP address: ${candidate}`);
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

function resolveConfiguredPath(value: string, cwd: string, homeDirectory: string): string {
  const expanded = value === "~" ? homeDirectory : value.startsWith("~/") ? join(homeDirectory, value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}

function readValue(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized || fallback;
}

function readPortValue(value: string | undefined, fallback: number): string {
  const candidate = value?.trim();
  if (candidate === undefined || candidate === "") return String(fallback);
  const parsed = Number(candidate);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`port must be an integer between 1 and 65535: ${candidate}`);
  }
  return String(parsed);
}

function readSchemaMode(value: string | undefined, name: MuximoEnvironmentName): "migrate" | "push" {
  const mode = value?.trim() || (name === "local" ? "push" : "migrate");
  if (mode !== "push" && mode !== "migrate") {
    throw new Error(`MUXIMO_SCHEMA_MODE must be push or migrate: ${mode}`);
  }
  return mode;
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
