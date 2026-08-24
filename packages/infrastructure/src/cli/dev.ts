import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorFields, type Logger } from "../logging/index.js";
import { normalizeAllowedOrigins } from "../process/daemon.js";

export type DevSupervisorInput = { serveProvider?: "tailscale" };
export type DevSupervisorDependencies = { logger?: Logger };

/** Starts the repository development supervisor with exact browser-origin configuration. */
export async function runDevCommand(
  input: DevSupervisorInput,
  environment: NodeJS.ProcessEnv,
  dependencies: DevSupervisorDependencies = {},
): Promise<number> {
  const logger = dependencies.logger;
  const repositoryRoot = findRepositoryRoot(environment.MUXIMO_REPOSITORY_ROOT ?? process.cwd());
  if (!repositoryRoot) throw new Error("muximo dev requires a source checkout containing scripts/dev.mjs");
  const allowedOrigins = resolveDevAllowedOrigins(input, environment);
  const childEnvironment: NodeJS.ProcessEnv = {
    ...environment,
    ...(input.serveProvider ? { MUXIMO_DEV_SERVE_PROVIDER: input.serveProvider } : {}),
    ...(allowedOrigins.length > 0 ? { MUXIMOD_ALLOWED_ORIGINS: allowedOrigins.join(",") } : {}),
  };
  const startedAt = Date.now();
  const child = spawn(environment.MUXIMO_BUN_BIN ?? "bun", ["scripts/dev.mjs"], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: "inherit",
  });
  logger?.debug("dev.supervisor_started", {
    pid: child.pid,
    repositoryRoot,
    serveProvider: input.serveProvider ?? "none",
    allowedOrigins,
  });
  let forwarding = false;
  const forwardSignal = (signal: NodeJS.Signals) => {
    if (forwarding) return;
    forwarding = true;
    logger?.debug("dev.supervisor_signal_forwarded", { pid: child.pid, signal });
    child.kill(signal);
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  try {
    return await new Promise<number>((resolvePromise, reject) => {
      child.once("error", (error) => {
        logger?.debug("dev.supervisor_failed", { pid: child.pid, ...errorFields(error) });
        reject(error);
      });
      child.once("exit", (code, signal) => {
        const status = code ?? signalExitCode(signal);
        logger?.debug("dev.supervisor_finished", {
          pid: child.pid,
          exitCode: code,
          signal,
          status,
          durationMs: Date.now() - startedAt,
        });
        resolvePromise(status);
      });
    });
  } finally {
    process.off("SIGINT", forwardSignal);
    process.off("SIGTERM", forwardSignal);
  }
}

export function resolveDevAllowedOrigins(input: DevSupervisorInput, environment: NodeJS.ProcessEnv): string[] {
  const configured = environment.MUXIMOD_ALLOWED_ORIGINS;
  if (configured !== undefined) return normalizeAllowedOrigins(configured.split(","));
  const webHost = normalizeBrowserHost(environment.VITE_DEV_HOST ?? "0.0.0.0");
  const webPort = readPort(environment.VITE_DEV_PORT, 5227);
  const origins = [`http://${formatHost(webHost)}:${webPort}`];
  if (input.serveProvider === "tailscale") {
    const hostname = environment.MUXIMO_TAILSCALE_HOSTNAME?.trim();
    if (hostname) {
      const externalPort = readPort(environment.MUXIMO_DEV_SERVE_PORT, 443);
      const protocolOrigin = externalPort === 443 ? `https://${hostname}` : `https://${hostname}:${externalPort}`;
      origins.push(new URL(protocolOrigin).origin);
    }
  }
  return normalizeAllowedOrigins(origins);
}

function findRepositoryRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "scripts", "dev.mjs"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
    return existsSync(join(sourceRoot, "scripts", "dev.mjs")) ? sourceRoot : undefined;
  } catch {
    return undefined;
  }
}

function normalizeBrowserHost(value: string): string {
  return value === "0.0.0.0" || value === "::" ? "127.0.0.1" : value;
}

function formatHost(value: string): string {
  return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
}

function readPort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error("development port must be between 1 and 65535");
  return port;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
