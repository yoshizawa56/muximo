import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { errorFields, type Logger } from "../logging/index.js";

export type DevSupervisorInput = { serveProvider?: "tailscale" };
export type DevSupervisorDependencies = { logger?: Logger };

/** Starts the repository development supervisor. */
export async function runDevCommand(
  input: DevSupervisorInput,
  environment: NodeJS.ProcessEnv,
  dependencies: DevSupervisorDependencies = {},
): Promise<number> {
  const logger = dependencies.logger;
  const repositoryRoot = findRepositoryRoot(environment.MUXIMO_REPOSITORY_ROOT ?? process.cwd());
  if (!repositoryRoot) throw new Error("muximo dev requires a source checkout containing portless.json");
  const childEnvironment: NodeJS.ProcessEnv = { ...environment };
  const childCwd = input.serveProvider ? join(repositoryRoot, "apps/serve") : repositoryRoot;
  const startedAt = Date.now();
  const child = spawn(environment.MUXIMO_BUN_BIN ?? "bun", ["dev"], {
    cwd: childCwd,
    env: childEnvironment,
    stdio: "inherit",
  });
  logger?.debug("dev.supervisor_started", {
    pid: child.pid,
    repositoryRoot,
    serveProvider: input.serveProvider ?? "none",
    childCwd,
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

function findRepositoryRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, "portless.json"))) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  try {
    const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
    return existsSync(join(sourceRoot, "portless.json")) ? sourceRoot : undefined;
  } catch {
    return undefined;
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
