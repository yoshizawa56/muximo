import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { ProcessResult } from "@muximo/application";
import type { Logger } from "../logging/index.js";

export type SpawnHooks = {
  onStarted?: (pid: number | undefined) => void | Promise<void>;
  onError?: (error: unknown) => void;
};

export async function spawnAttached(
  binary: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  hooks: SpawnHooks = {},
): Promise<ProcessResult & { pid?: number }> {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(binary, args, { cwd, env: environment, stdio: "inherit" });
  } catch (error) {
    hooks.onError?.(error);
    return { code: 127, interrupted: false };
  }
  let interrupted = false;
  const onInterrupt = (signal: NodeJS.Signals) => {
    interrupted = true;
    child.kill(signal);
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  const started = new Promise<boolean>((resolvePromise) => {
    child.once("spawn", () => resolvePromise(true));
    child.once("error", () => resolvePromise(false));
  });
  const result = new Promise<ProcessResult & { pid?: number }>((resolvePromise) => {
    child.once("error", (error) => {
      hooks.onError?.(error);
      resolvePromise({ code: 127, interrupted, pid: child.pid, signal: null });
    });
    child.once("close", (code, signal) =>
      resolvePromise({ code: code ?? signalExitCode(signal), interrupted, pid: child.pid, signal }),
    );
  });
  try {
    if (await started) await hooks.onStarted?.(child.pid);
    return await result;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
}

export async function runAttachedProcess(
  binary: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  logger?: Pick<Logger, "debug">,
  kind = "attached",
): Promise<number> {
  const startedAt = Date.now();
  logger?.debug("subprocess.starting", { kind, executable: basename(binary), cwd, argumentCount: args.length });
  const result = await spawnAttached(binary, args, cwd, environment, {
    onStarted: (pid) => logger?.debug("subprocess.started", { kind, executable: basename(binary), pid }),
    onError: (error) => logger?.debug("subprocess.spawn_failed", { kind, executable: basename(binary), error }),
  });
  logger?.debug("subprocess.finished", {
    kind,
    executable: basename(binary),
    pid: result.pid,
    exitCode: result.code,
    signal: result.signal,
    interrupted: result.interrupted,
    durationMs: Date.now() - startedAt,
  });
  return result.code;
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

export function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
