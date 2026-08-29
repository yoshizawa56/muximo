import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isLoopbackOrPrivateBindHost, type Profile } from "@muximo/profile";

const defaultWebOptions = {
  host: "127.0.0.1",
  port: 5227,
  externalPort: 8449,
} as const;

export type WebOptions = {
  environmentName?: string;
  stateRoot: string;
  webInstanceDirectory: string;
  host: string;
  port: number;
  externalPort: number;
  environment: NodeJS.ProcessEnv;
};

/** Resolves only Web-owned settings from the raw profile environment. */
export function resolveWebOptions(profile: Profile, cwd: string): WebOptions {
  const environmentName = profile.name;
  const environment = profile.environment;
  const homeDirectory = environment.HOME ?? homedir();
  const stateRoot = resolveConfiguredPath(
    readValue(environment.MUXIMO_STATE_ROOT, join(homeDirectory, ".local", "state", "muximo")),
    cwd,
    homeDirectory,
  );
  const webInstanceDirectory = join(stateRoot, ...(environmentName === undefined ? [] : [environmentName]), "web");
  const host = readBindHost(readValue(environment.MUXIMO_WEB_HOST, defaultWebOptions.host));
  const port = readPort(environment.MUXIMO_WEB_PORT, defaultWebOptions.port, "MUXIMO_WEB_PORT");
  const externalPort = readPort(
    environment.MUXIMO_WEB_SERVE_PORT,
    defaultWebOptions.externalPort,
    "MUXIMO_WEB_SERVE_PORT",
  );
  const resolvedEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    MUXIMO_WEB_INSTANCE_DIR: webInstanceDirectory,
    MUXIMO_WEB_HOST: host,
    VITE_DEV_HOST: host,
    VITE_DEV_PORT: String(port),
    MUXIMO_WEB_SERVE_PORT: String(externalPort),
  };
  if (environmentName === undefined) delete resolvedEnvironment.MUXIMO_ENV;
  else resolvedEnvironment.MUXIMO_ENV = environmentName;

  return {
    environmentName,
    stateRoot,
    webInstanceDirectory,
    host,
    port,
    externalPort,
    environment: resolvedEnvironment,
  };
}

function readValue(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function readBindHost(value: string): string {
  const normalized = value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
  if (isLoopbackOrPrivateBindHost(normalized)) return normalized;
  throw new Error(`MUXIMO_WEB_HOST must be localhost, a loopback address, or a private IP address: ${value}`);
}

function readPort(value: string | undefined, fallback: number, variableName: string): number {
  const candidate = readValue(value, String(fallback));
  const port = Number(candidate);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variableName} must be an integer between 1 and 65535: ${candidate}`);
  }
  return port;
}

function resolveConfiguredPath(value: string, cwd: string, homeDirectory: string): string {
  const expanded = value === "~" ? homeDirectory : value.startsWith("~/") ? join(homeDirectory, value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : join(cwd, expanded));
}
