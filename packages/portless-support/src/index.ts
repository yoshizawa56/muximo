import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RouteStore } from "portless";

export const portlessServices = ["web", "muximod"] as const;
export type PortlessService = (typeof portlessServices)[number];

export type PortlessAppConfig = {
  name: string;
  script?: string;
};

export type PortlessConfig = {
  apps: Record<string, PortlessAppConfig>;
};

export type PortlessServiceRuntime = {
  service: PortlessService;
  name: string;
  host: string;
  port: number;
  hostname: string;
  publicUrl: string;
  publicOrigin: string;
  localUrl: string;
};

export type PortlessRoute = {
  hostname: string;
  port: number;
  pid: number;
};

export type PortlessServiceRoute = PortlessServiceRuntime & {
  routePort: number;
  routePid: number;
};

type Environment = NodeJS.ProcessEnv;

const serviceDefinitions: Record<
  PortlessService,
  { packagePath: string; defaultPort: number; portEnvironmentVariable: string }
> = {
  web: {
    packagePath: "apps/web",
    defaultPort: 5227,
    portEnvironmentVariable: "VITE_DEV_PORT",
  },
  muximod: {
    packagePath: "apps/muximod",
    defaultPort: 4317,
    portEnvironmentVariable: "MUXIMOD_PORT",
  },
};

const defaultPortlessTld = "localhost";

/** Finds the source checkout containing the Portless JSON configuration. */
export function resolveRepositoryRoot(startDirectory = process.cwd()): string {
  let current = resolve(startDirectory);
  while (true) {
    if (existsSync(join(current, "portless.json"))) return current;
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`could not find portless.json from ${startDirectory}`);
}

/** Reads and validates the JSON consumed by the Portless CLI. */
export function readPortlessConfig(repositoryRoot: string): PortlessConfig {
  const configPath = join(repositoryRoot, "portless.json");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`could not read ${configPath}`, { cause: error });
  }

  if (!isRecord(value) || !isRecord(value.apps)) {
    throw new Error(`${configPath} must contain an apps object`);
  }

  const apps: Record<string, PortlessAppConfig> = {};
  for (const [packagePath, rawConfig] of Object.entries(value.apps)) {
    if (!isRecord(rawConfig) || typeof rawConfig.name !== "string" || !rawConfig.name.trim()) {
      throw new Error(`${configPath} apps.${packagePath}.name must be a non-empty string`);
    }
    if (rawConfig.script !== undefined && typeof rawConfig.script !== "string") {
      throw new Error(`${configPath} apps.${packagePath}.script must be a string`);
    }
    const script = typeof rawConfig.script === "string" ? rawConfig.script.trim() : undefined;
    if (rawConfig.script !== undefined && !script) {
      throw new Error(`${configPath} apps.${packagePath}.script must be a non-empty string`);
    }
    apps[packagePath] = {
      name: rawConfig.name.trim(),
      ...(script ? { script } : {}),
    };
  }
  return { apps };
}

/**
 * Loads `.env` into the supplied environment without replacing explicit
 * process variables. The mutation is intentional so child processes inherit
 * the same development configuration.
 */
export function loadDevelopmentEnvironment(
  options: { repositoryRoot?: string; environment?: Environment; fileName?: string } = {},
): Environment {
  const environment = options.environment ?? process.env;
  const repositoryRoot = options.repositoryRoot ?? resolveRepositoryRoot();
  const filePath = join(repositoryRoot, options.fileName ?? ".env");
  if (!existsSync(filePath)) return environment;

  const values = parseDotEnv(readFileSync(filePath, "utf8"), filePath);
  for (const [key, value] of Object.entries(values)) {
    if (environment[key] === undefined) environment[key] = value;
  }
  return environment;
}

/** Starts the configured service through the Portless proxy. */
export async function runPortlessService(
  service: PortlessService,
  options: { repositoryRoot?: string; environment?: Environment; args?: readonly string[] } = {},
): Promise<number> {
  const environment = loadDevelopmentEnvironment({
    repositoryRoot: options.repositoryRoot,
    environment: options.environment,
  });
  const repositoryRoot = options.repositoryRoot ?? resolveRepositoryRoot();
  const config = readPortlessConfig(repositoryRoot);
  const definition = serviceDefinitions[service];
  const appConfig = config.apps[definition.packagePath];
  if (!appConfig) throw new Error(`portless.json has no configuration for ${definition.packagePath}`);

  const portlessCli = resolvePortlessCli();
  const script = appConfig.script ?? "dev";
  const child = spawn(
    process.execPath,
    [
      portlessCli,
      "run",
      "--name",
      appConfig.name,
      "--",
      environment.MUXIMO_BUN_BIN ?? "bun",
      "run",
      script,
      ...(options.args ?? []),
    ],
    {
      cwd: join(repositoryRoot, definition.packagePath),
      env: environment,
      stdio: "inherit",
    },
  );

  let forwarding = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (forwarding) return;
    forwarding = true;
    child.kill(signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    return await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolvePromise(code ?? signalExitCode(signal)));
    });
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

/** Parses the small, portable subset of dotenv syntax needed by dev files. */
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

/** Applies Portless's child-process values to an application's server env. */
export function configurePortlessService(
  service: PortlessService,
  options: { repositoryRoot?: string; environment?: Environment } = {},
): PortlessServiceRuntime {
  const environment = options.environment ?? process.env;
  const repositoryRoot = options.repositoryRoot ?? resolveRepositoryRoot();
  const runtime = resolvePortlessService(service, { repositoryRoot, environment });
  const definition = serviceDefinitions[service];

  environment.HOST = runtime.host;
  environment[definition.portEnvironmentVariable] = String(runtime.port);

  if (service === "web") {
    environment.VITE_DEV_HOST = runtime.host;
    appendEnvironmentValue(environment, "VITE_ALLOWED_HOSTS", runtime.hostname);
  } else {
    if (environment.MUXIMOD_PAIRING_BASE_URL === undefined) {
      environment.MUXIMOD_PAIRING_BASE_URL = runtime.publicUrl;
    }
    if (environment.MUXIMOD_ALLOWED_ORIGINS === undefined) {
      const webUrl = resolvePortlessPeerUrl("muximod", { repositoryRoot, environment });
      if (webUrl) environment.MUXIMOD_ALLOWED_ORIGINS = webUrl.origin;
    }
  }

  return runtime;
}

/** Resolves the current service from Portless's injected child environment. */
export function resolvePortlessService(
  service: PortlessService,
  options: { repositoryRoot?: string; environment?: Environment } = {},
): PortlessServiceRuntime {
  const environment = options.environment ?? process.env;
  const repositoryRoot = options.repositoryRoot ?? resolveRepositoryRoot();
  const config = readPortlessConfig(repositoryRoot);
  const definition = serviceDefinitions[service];
  const appConfig = config.apps[definition.packagePath];
  if (!appConfig) throw new Error(`portless.json has no configuration for ${definition.packagePath}`);

  const host = normalizeHost(environment.HOST ?? "127.0.0.1");
  const port = readPort(
    environment.PORT ?? environment[definition.portEnvironmentVariable],
    definition.defaultPort,
    service,
  );
  const publicUrl = normalizeUrl(environment.PORTLESS_URL ?? `http://${formatHost(host)}:${port}`);
  return {
    service,
    name: appConfig.name,
    host,
    port,
    hostname: publicUrl.hostname,
    publicUrl: publicUrl.toString(),
    publicOrigin: publicUrl.origin,
    localUrl: `http://${formatHost(host)}:${port}`,
  };
}

/** Resolves the peer service's Portless URL using the current worktree host. */
export function resolvePortlessPeerUrl(
  service: PortlessService,
  options: { repositoryRoot?: string; environment?: Environment } = {},
): URL | undefined {
  const environment = options.environment ?? process.env;
  if (!environment.PORTLESS_URL) return undefined;

  const repositoryRoot = options.repositoryRoot ?? resolveRepositoryRoot();
  const current = resolvePortlessService(service, { repositoryRoot, environment });
  const peer = service === "web" ? "muximod" : "web";
  const peerRuntime = resolvePortlessService(peer, { repositoryRoot, environment });
  const peerHostname = replacePortlessServiceHostname(current.hostname, current.name, peerRuntime.name);
  if (!peerHostname) return undefined;

  const peerUrl = new URL(current.publicUrl);
  peerUrl.hostname = peerHostname;
  peerUrl.pathname = "/";
  peerUrl.search = "";
  peerUrl.hash = "";
  return peerUrl;
}

/** Reads the active local port that Portless registered for a service. */
export function resolvePortlessRoute(
  service: PortlessService,
  options: { repositoryRoot?: string; environment?: Environment } = {},
): PortlessServiceRoute | undefined {
  const runtime = resolvePortlessService(service, options);
  const stateDirectory = resolvePortlessStateDirectory(options.environment ?? process.env);
  const routes = new RouteStore(stateDirectory).loadRoutes() as PortlessRoute[];
  const routeHostname = environmentHasPortlessUrl(options.environment ?? process.env)
    ? runtime.hostname
    : resolvePortlessServiceHostname(service, options);
  const route = routes.find((candidate) => candidate.hostname === routeHostname);
  if (!route) return undefined;
  return { ...runtime, routePort: route.port, routePid: route.pid };
}

/** Resolves the hostname Portless assigns outside the child process. */
export function resolvePortlessServiceHostname(
  service: PortlessService,
  options: { repositoryRoot?: string; environment?: Environment } = {},
): string {
  const environment = options.environment ?? process.env;
  const repositoryRoot = options.repositoryRoot ?? resolveRepositoryRoot();
  const config = readPortlessConfig(repositoryRoot);
  const definition = serviceDefinitions[service];
  const appConfig = config.apps[definition.packagePath];
  if (!appConfig) throw new Error(`portless.json has no configuration for ${definition.packagePath}`);
  const prefix = resolveWorktreePrefix(repositoryRoot);
  const name = prefix ? `${prefix}.${appConfig.name}` : appConfig.name;
  return `${name}.${readPortlessTld(environment)}`;
}

/** Waits for a Portless child to publish its route in the shared route store. */
export async function waitForPortlessRoute(
  service: PortlessService,
  options: { repositoryRoot?: string; environment?: Environment; timeoutMs?: number; intervalMs?: number } = {},
): Promise<PortlessServiceRoute> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const intervalMs = options.intervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const route = resolvePortlessRoute(service, options);
    if (route) return route;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`${service} did not publish a Portless route within ${timeoutMs}ms`);
}

export function resolvePortlessStateDirectory(environment: Environment = process.env): string {
  return resolve(environment.PORTLESS_STATE_DIR ?? join(environment.HOME ?? homedir(), ".portless"));
}

function replacePortlessServiceHostname(hostname: string, currentName: string, peerName: string): string | undefined {
  const serviceMarker = `.${currentName}.`;
  const markerIndex = hostname.lastIndexOf(serviceMarker);
  if (markerIndex >= 0) {
    return `${hostname.slice(0, markerIndex)}.${peerName}.${hostname.slice(markerIndex + serviceMarker.length)}`;
  }
  if (hostname.startsWith(`${currentName}.`)) {
    return `${peerName}.${hostname.slice(currentName.length + 1)}`;
  }
  return undefined;
}

function resolvePortlessCli(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("portless"))), "cli.js");
}

function environmentHasPortlessUrl(environment: Environment): boolean {
  return typeof environment.PORTLESS_URL === "string" && environment.PORTLESS_URL.trim().length > 0;
}

function resolveWorktreePrefix(repositoryRoot: string): string | undefined {
  try {
    const worktreeList = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (worktreeList.split("\n").filter((line) => line.startsWith("worktree ")).length <= 1) return undefined;

    const gitDirectory = resolve(
      repositoryRoot,
      execFileSync("git", ["rev-parse", "--git-dir"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    const commonGitDirectory = resolve(
      repositoryRoot,
      execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    if (gitDirectory === commonGitDirectory) return undefined;

    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!branch || branch === "HEAD" || branch === "main" || branch === "master") return undefined;
    return sanitizeHostnameLabel(branch.split("/").pop() ?? "");
  } catch {
    return undefined;
  }
}

function sanitizeHostnameLabel(value: string): string | undefined {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^-+|-+$/gu, "");
  if (!sanitized) return undefined;
  if (sanitized.length <= 63) return sanitized;
  const hash = createHashLabel(sanitized);
  return `${sanitized.slice(0, 56).replace(/-+$/gu, "")}-${hash}`;
}

function createHashLabel(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 6);
}

function appendEnvironmentValue(environment: Environment, key: string, value: string): void {
  const values = (environment[key] ?? "")
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (!values.includes(value)) values.push(value);
  environment[key] = values.join(",");
}

function readPort(value: string | undefined, fallback: number, service: PortlessService): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${service} development port must be an integer between 1 and 65535`);
  }
  return port;
}

function readPortlessTld(environment: Environment): string {
  const stateDirectory = resolvePortlessStateDirectory(environment);
  for (const fileName of ["proxy.tlds", "proxy.tld"]) {
    try {
      const value = readFileSync(join(stateDirectory, fileName), "utf8")
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .find(Boolean);
      if (value) return value.replace(/^\.+/u, "");
    } catch {
      // Fall back to the environment when Portless has not started yet.
    }
  }
  return environment.PORTLESS_TLD?.split(",")[0]?.trim().replace(/^\.+/u, "") || defaultPortlessTld;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function normalizeHost(value: string): string {
  if (value === "0.0.0.0" || value === "::") return "127.0.0.1";
  return value;
}

function formatHost(value: string): string {
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function normalizeUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`PORTLESS_URL must be a valid URL: ${value}`, { cause: error });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`PORTLESS_URL must use http or https: ${value}`);
  }
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  url.search = "";
  url.hash = "";
  return url;
}

function parseDotEnvValue(value: string, source: string, lineNumber: number): string {
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length === 1) {
      throw new Error(`${source}:${lineNumber}: unterminated single-quoted value`);
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length === 1) {
      throw new Error(`${source}:${lineNumber}: unterminated double-quoted value`);
    }
    return value.slice(1, -1).replace(/\\([\\nrt"])/gu, (_match, character: string) => {
      if (character === "n") return "\n";
      if (character === "r") return "\r";
      if (character === "t") return "\t";
      return character;
    });
  }
  return value.replace(/\s+#.*$/u, "").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
