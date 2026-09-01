import { execFileSync, spawn } from "node:child_process";
import { basename } from "node:path";
import type { ProcessResult } from "@muximo/application";
import { errorMessage, type Logger } from "../logging/index.js";

export type SpawnHooks = {
  onStarted?: (pid: number | undefined, startedAt: string) => void;
  onError?: (error: unknown) => void;
  captureFailureDiagnostic?: boolean;
  signal?: AbortSignal;
};

const maxFailureDiagnosticBytes = 16_384;
const maxFailureDiagnosticLength = 4_096;

export async function spawnAttached(
  binary: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
  hooks: SpawnHooks = {},
): Promise<ProcessResult & { pid?: number }> {
  let child: ReturnType<typeof spawn>;
  const captureFailureDiagnostic = hooks.captureFailureDiagnostic === true;
  let stderr = Buffer.alloc(0);
  try {
    child = spawn(binary, args, {
      cwd,
      env: environment,
      stdio: captureFailureDiagnostic ? ["inherit", "inherit", "pipe"] : "inherit",
    });
  } catch (error) {
    hooks.onError?.(error);
    const diagnostic = sanitizeProcessDiagnostic(errorMessage(error));
    return {
      started: false,
      code: 127,
      interrupted: false,
      ...(diagnostic === undefined ? {} : { failureDiagnostic: diagnostic }),
    };
  }
  if (captureFailureDiagnostic) {
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const diagnostic = sanitizeProcessDiagnosticContent(`${stderr.toString("utf8")}${bytes.toString("utf8")}`);
      stderr = Buffer.from(diagnostic).subarray(-maxFailureDiagnosticBytes);
    });
  }
  let interrupted = false;
  let processStarted = false;
  const onInterrupt = (signal: NodeJS.Signals) => {
    interrupted = true;
    child.kill(signal);
  };
  const onAbort = () => {
    interrupted = true;
    child.kill("SIGTERM");
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  if (hooks.signal) {
    if (hooks.signal.aborted) onAbort();
    else hooks.signal.addEventListener("abort", onAbort, { once: true });
  }
  const started = new Promise<boolean>((resolvePromise) => {
    child.once("spawn", () => {
      processStarted = true;
      resolvePromise(true);
    });
    child.once("error", () => resolvePromise(false));
  });
  const result = new Promise<ProcessResult & { pid?: number }>((resolvePromise) => {
    child.once("error", (error) => {
      hooks.onError?.(error);
      resolvePromise(
        withFailureDiagnostic({ started: false, code: 127, interrupted, pid: child.pid, signal: null }, stderr, error),
      );
    });
    child.once("close", (code, signal) =>
      resolvePromise(
        withFailureDiagnostic(
          { started: processStarted, code: code ?? signalExitCode(signal), interrupted, pid: child.pid, signal },
          stderr,
        ),
      ),
    );
  });
  try {
    if (await started) hooks.onStarted?.(child.pid, new Date().toISOString());
    return await result;
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
    hooks.signal?.removeEventListener("abort", onAbort);
  }
}

export function sanitizeProcessDiagnostic(value: string): string | undefined {
  const normalized = sanitizeProcessDiagnosticContent(value).replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxFailureDiagnosticLength
    ? normalized
    : `…${normalized.slice(-(maxFailureDiagnosticLength - 1))}`;
}

function sanitizeProcessDiagnosticContent(value: string): string {
  return errorMessage(value)
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\|$)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\u009D[^\u0007]*(?:\u0007|\u009C|\u001B\\|$)/gu, "")
    .replace(/\u009B[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/gu, "");
}

function withFailureDiagnostic(
  result: ProcessResult & { pid?: number },
  stderr: Buffer,
  spawnError?: unknown,
): ProcessResult & { pid?: number } {
  if (result.code === 0) return result;
  const diagnostic = sanitizeProcessDiagnostic(
    stderr.byteLength > 0 ? stderr.toString("utf8") : spawnError === undefined ? "" : errorMessage(spawnError),
  );
  return diagnostic === undefined ? result : { ...result, failureDiagnostic: diagnostic };
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
    started: result.started,
    exitCode: result.code,
    signal: result.signal,
    interrupted: result.interrupted,
    durationMs: Date.now() - startedAt,
  });
  return result.code;
}

export type ProcessLiveness = "alive" | "dead" | "unknown";

/**
 * Observes process liveness without treating an unavailable identity probe as
 * proof that a process is dead. Callers that delete or terminate resources
 * must only act on an explicit `dead` result.
 */
export function observeProcessLiveness(pid: number, expectedStartedAt?: string): ProcessLiveness {
  if (!Number.isInteger(pid) || pid <= 0) return "dead";
  try {
    process.kill(pid, 0);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : undefined;
    if (code === "ESRCH") return "dead";
    if (code !== "EPERM") return "unknown";
  }
  if (expectedStartedAt === undefined) return "alive";
  const expectedStartedAtMs = Date.parse(expectedStartedAt);
  if (!Number.isFinite(expectedStartedAtMs)) return "unknown";
  const processStartedAtMs = readProcessStartedAt(pid);
  if (processStartedAtMs === undefined) return "unknown";
  return isProcessStartTimeValid(expectedStartedAt, processStartedAtMs) ? "alive" : "dead";
}

export function isProcessAlive(pid: number, expectedStartedAt?: string): boolean {
  return observeProcessLiveness(pid, expectedStartedAt) === "alive";
}

/** Returns the current process start time when the host can observe it. */
export function currentProcessStartedAt(): string | undefined {
  const startedAt = readProcessStartedAt(process.pid);
  return startedAt === undefined ? undefined : new Date(startedAt).toISOString();
}

export function isProcessStartTimeValid(expectedStartedAt: string, actualStartedAtMs: number): boolean {
  const expectedStartedAtMs = Date.parse(expectedStartedAt);
  return (
    Number.isFinite(expectedStartedAtMs) &&
    Number.isFinite(actualStartedAtMs) &&
    actualStartedAtMs <= expectedStartedAtMs
  );
}

function readProcessStartedAt(pid: number): number | undefined {
  if (process.platform === "win32") return undefined;
  try {
    const value = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const startedAt = Date.parse(value);
    return Number.isFinite(startedAt) ? startedAt : undefined;
  } catch {
    return undefined;
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
