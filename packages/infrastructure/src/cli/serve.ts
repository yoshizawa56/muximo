import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { errorFields, errorMessage, type Logger, type LogLevel } from "../logging/index.js";
import {
  buildServeArgs,
  buildServeHttpUrl,
  buildTailscaleInvocation,
  normalizeTailscaleStdout,
  parseTailscaleHostname,
} from "../tailscale/index.js";

const execFile = promisify(execFileCallback);
const tailscaleCommandTimeoutMs = 15_000;

export type ServeInput = {
  provider: "tailscale";
  foreground: boolean;
  muximodHost: string;
  muximodPort: number;
  externalPort: number;
  pidFile?: string;
  logLevel: "error" | "warn" | "info" | "debug";
  logFile?: string;
  allowedOrigins?: readonly string[];
};

export type ServeCommandOptions = ServeInput & { tailscaleBinary: string; hostname?: string; muximodBaseUrl?: string };

export type ServeProcessHandle = {
  pid?: number;
  wait(): Promise<{ code: number; interrupted: boolean; signal?: string | null }>;
  terminate(signal?: "SIGINT" | "SIGTERM"): void;
};

export type ServeCommandDependencies = {
  ensureMuximod: (
    options: ServeCommandOptions,
    allowedOrigins: readonly string[],
  ) => Promise<ServeProcessHandle | undefined>;
  runCommand?: CommandRunner;
  logger?: Logger;
};

export type TailscaleServeResult = {
  options: ServeCommandOptions;
  serveArgs: string[];
  hostname?: string;
  url?: string;
  localUrl: string;
  allowedOrigins: readonly string[];
  stdout: string;
  stderr: string;
  foregroundProcess?: ServeProcessHandle;
};

type CommandRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

/** Configures Tailscale Serve after muximod receives exact browser origins. */
export async function ensureTailscaleServe(
  input: ServeInput,
  dependencies: ServeCommandDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<TailscaleServeResult> {
  const options: ServeCommandOptions = {
    ...input,
    tailscaleBinary: environment.TAILSCALE_BIN ?? "tailscale",
    hostname: environment.MUXIMO_TAILSCALE_HOSTNAME,
  };
  const runCommand = dependencies.runCommand ?? runExternalCommand;
  const logger = dependencies.logger;
  const startedAt = Date.now();
  logger?.debug("serve.started", {
    muximodHost: options.muximodHost,
    muximodPort: options.muximodPort,
    externalPort: options.externalPort,
    logLevel: options.logLevel,
    logFileConfigured: Boolean(options.logFile),
  });
  let hostname = options.hostname;
  if (!hostname && !options.allowedOrigins?.length && !environment.MUXIMOD_ALLOWED_ORIGINS) {
    hostname = await discoverHostname(options.tailscaleBinary, runCommand, environment, logger);
  }
  const allowedOrigins = resolveServeAllowedOrigins(options, environment, hostname);
  const localUrl = localMuximodUrl(options.muximodHost, options.muximodPort);
  const url = hostname
    ? buildServeHttpUrl(hostname, options.externalPort)
    : (environment.MUXIMOD_PAIRING_BASE_URL ?? localUrl);
  const muximodStartedAt = Date.now();
  let foregroundProcess: ServeProcessHandle | undefined;
  try {
    foregroundProcess = await dependencies.ensureMuximod(
      { ...options, allowedOrigins, muximodBaseUrl: url },
      allowedOrigins,
    );
    logger?.debug("muximod.ensure_finished", { durationMs: Date.now() - muximodStartedAt });
  } catch (error) {
    logger?.debug("muximod.ensure_failed", { durationMs: Date.now() - muximodStartedAt, ...errorFields(error) });
    throw error;
  }
  const serveArgs = buildServeArgs({ localPort: options.muximodPort, externalPort: options.externalPort });
  const commandStartedAt = Date.now();
  let result: { stdout: string; stderr: string };
  try {
    result = await runCommand(options.tailscaleBinary, serveArgs, { env: environment });
  } catch (error) {
    foregroundProcess?.terminate("SIGTERM");
    await foregroundProcess?.wait().catch(() => undefined);
    throw error;
  }
  logger?.debug("serve.subprocess_finished", {
    kind: "tailscale",
    durationMs: Date.now() - commandStartedAt,
  });
  logger?.debug("serve.finished", {
    durationMs: Date.now() - startedAt,
    hostnameResolved: Boolean(hostname),
    allowedOrigins,
  });
  return {
    options,
    serveArgs,
    hostname,
    url,
    localUrl: localMuximodUrl(options.muximodHost, options.muximodPort),
    allowedOrigins,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(foregroundProcess ? { foregroundProcess } : {}),
  };
}

export function resolveServeAllowedOrigins(
  options: Pick<ServeInput, "externalPort" | "allowedOrigins">,
  environment: NodeJS.ProcessEnv,
  hostname?: string,
): string[] {
  if (options.allowedOrigins?.length) return normalizeAllowedOrigins(options.allowedOrigins);
  if (environment.MUXIMOD_ALLOWED_ORIGINS !== undefined) {
    return normalizeAllowedOrigins(environment.MUXIMOD_ALLOWED_ORIGINS.split(","));
  }
  if (!hostname) {
    throw new Error("could not determine the browser origin; set MUXIMO_TAILSCALE_HOSTNAME or MUXIMOD_ALLOWED_ORIGINS");
  }
  return normalizeAllowedOrigins([new URL(buildServeHttpUrl(hostname, options.externalPort)).origin]);
}

export function normalizeAllowedOrigins(origins: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of origins) {
    const origin = value.trim();
    if (!origin) continue;
    if (origin === "*") throw new Error("wildcard browser origins are not allowed");
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch (error) {
      throw new Error(`invalid browser origin: ${origin}`, { cause: error });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`browser origin must use http or https: ${origin}`);
    }
    if (parsed.origin !== origin.replace(/\/$/u, "")) {
      throw new Error(`browser origin must not include a path: ${origin}`);
    }
    normalized.add(parsed.origin);
  }
  return [...normalized].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function localMuximodUrl(host: string, port: number): string {
  const normalizedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const urlHost =
    normalizedHost.includes(":") && !normalizedHost.startsWith("[") ? `[${normalizedHost}]` : normalizedHost;
  return `http://${urlHost}:${port}`;
}

async function discoverHostname(
  binary: string,
  runCommand: CommandRunner,
  environment: NodeJS.ProcessEnv,
  logger?: Logger,
): Promise<string | undefined> {
  try {
    const result = await runCommand(binary, ["status", "--json"], { env: environment });
    return parseTailscaleHostname(result.stdout);
  } catch (error) {
    logger?.debug("serve.hostname_lookup_failed", errorFields(error));
    return undefined;
  }
}

async function runExternalCommand(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  try {
    const invocation = buildTailscaleInvocation(command, args, options.env);
    const result = await execFile(invocation.command, invocation.args, {
      env: invocation.environment,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: tailscaleCommandTimeoutMs,
    });
    return { ...result, stdout: normalizeTailscaleStdout(result.stdout, invocation) };
  } catch (error) {
    throw new Error(`could not run ${command}: ${errorMessage(error)}`, { cause: error });
  }
}

export function resolveServeLogOptions(environment: NodeJS.ProcessEnv): Pick<ServeInput, "logLevel" | "logFile"> {
  const value = environment.MUXIMO_LOG_LEVEL ?? "info";
  if (value !== "error" && value !== "warn" && value !== "info" && value !== "debug") {
    throw new Error("MUXIMO_LOG_LEVEL must be one of error, warn, info, or debug");
  }
  return {
    logLevel: value as LogLevel,
    logFile: environment.MUXIMO_LOG_FILE ? resolve(environment.MUXIMO_LOG_FILE) : undefined,
  };
}
