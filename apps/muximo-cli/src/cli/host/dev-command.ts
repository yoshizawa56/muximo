import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorFields, type Logger } from "@muximo/infrastructure";

export type DevCommandOptions = {
  verbose?: boolean;
  logger?: Logger;
};

export async function runDevCommand(
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  options: DevCommandOptions = {},
): Promise<number> {
  const logger = options.logger;
  const startedAt = Date.now();
  const serveProvider = parseDevServeProvider(args);
  const repositoryRoot = findRepositoryRoot(environment.MUXIMO_REPOSITORY_ROOT ?? process.cwd());
  if (!repositoryRoot) {
    throw new Error("muximo dev requires a source checkout containing scripts/dev.mjs");
  }

  const childEnvironment = {
    ...environment,
    ...(serveProvider ? { MUXIMO_DEV_SERVE_PROVIDER: serveProvider } : {}),
    ...(options.verbose ? { MUXIMO_DEV_VERBOSE: "1" } : {}),
  };
  const child = spawn(environment.MUXIMO_BUN_BIN ?? "bun", ["scripts/dev.mjs"], {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: "inherit",
  });
  logger?.debug("dev.supervisor_started", {
    pid: child.pid,
    repositoryRoot,
    serveProvider: serveProvider ?? "none",
    verbose: Boolean(options.verbose),
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

export function parseDevServeProvider(args: string[]): "tailscale" | undefined {
  if (args.length === 0) return undefined;
  const [command, provider, ...rest] = args;
  if (command !== "serve") throw new Error(`unknown muximo dev command: ${command}`);
  if (provider !== "tailscale") throw new Error(`unsupported dev serve provider: ${provider ?? "missing"}`);
  if (rest.length > 0) throw new Error(`unknown muximo dev option: ${rest[0]}`);
  return provider;
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
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
    return existsSync(join(sourceRoot, "scripts", "dev.mjs")) ? sourceRoot : undefined;
  } catch {
    return undefined;
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
