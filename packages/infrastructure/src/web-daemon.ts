import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { errorMessage } from "./logging/index.js";

const startLockTimeoutMs = 15_000;
const pollIntervalMs = 50;
const readinessTimeoutMs = 10_000;
const readinessProbeTimeoutMs = 500;

export type WebDaemonStatus = {
  state: "running" | "stopped" | "stale";
  pid?: number;
  url: string;
  logFile: string;
};

export type WebDaemonManager = {
  start(): Promise<WebDaemonStatus>;
  restart(): Promise<WebDaemonStatus>;
  stop(): Promise<WebDaemonStatus>;
  status(): Promise<WebDaemonStatus>;
};

export type WebDaemonManagerOptions = {
  instanceDirectory: string;
  host: string;
  port: number;
  cwd: string;
  command: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  logFile?: string;
};

type WebPidRecord = {
  pid: number;
  host: string;
  port: number;
  command: string;
  args: string[];
  startedAt: string;
};

/** Manages exactly one host-side Web process for one environment state directory. */
export function createWebDaemonManager(options: WebDaemonManagerOptions): WebDaemonManager {
  mkdirSync(options.instanceDirectory, { recursive: true, mode: 0o700 });
  const pidFile = join(options.instanceDirectory, "web.pid");
  const logFile = options.logFile ?? join(options.instanceDirectory, "web.log");
  const lockDirectory = join(options.instanceDirectory, "web.start.lock");
  const url = `http://${displayHost(options.host)}:${options.port}`;

  return {
    start: () => withStartLock(() => start(), lockDirectory),
    restart: () =>
      withStartLock(async () => {
        await stop();
        return start();
      }, lockDirectory),
    stop: () => withStartLock(() => stop(), lockDirectory),
    status,
  };

  async function start(): Promise<WebDaemonStatus> {
    validateOptions();
    const current = readPidRecord(pidFile);
    if (current) {
      if (await isReady(current)) return present("running", current.pid);
      if (isProcessAlive(current.pid)) {
        throw new Error(`Web process ${current.pid} owns ${url} but is not ready; inspect ${logFile}`);
      }
      removePidRecord(current.pid);
    }

    if (await isEndpointReady()) {
      throw new Error(`Web port is already in use by an unmanaged process: ${url}`);
    }

    mkdirSync(options.instanceDirectory, { recursive: true, mode: 0o700 });
    const logDescriptor = openSync(logFile, "a", 0o600);
    let child: ChildProcess;
    let childError: unknown;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        env: { ...options.environment },
        detached: process.platform !== "win32",
        stdio: ["ignore", logDescriptor, logDescriptor],
      });
      child.once("error", (error) => {
        childError = error;
      });
    } catch (error) {
      closeDescriptor(logDescriptor);
      throw new Error(`could not start Web: ${errorMessage(error)}`, { cause: error });
    }
    closeDescriptor(logDescriptor);
    if (child.pid === undefined) throw new Error("Web process did not provide a PID");

    const record: WebPidRecord = {
      pid: child.pid,
      host: options.host,
      port: options.port,
      command: options.command,
      args: [...options.args],
      startedAt: new Date().toISOString(),
    };
    writePidRecord(record);
    child.unref();

    try {
      await waitForReady(record, () => childError);
      return present("running", record.pid);
    } catch (error) {
      terminate(record.pid);
      removePidRecord(record.pid);
      throw new Error(`Web failed to become ready on ${url}; inspect ${logFile}`, { cause: error });
    }
  }

  async function stop(): Promise<WebDaemonStatus> {
    const current = readPidRecord(pidFile);
    if (!current) return present("stopped");
    if (!isProcessAlive(current.pid)) {
      removePidRecord(current.pid);
      return present("stale", current.pid);
    }

    terminate(current.pid);
    const deadline = Date.now() + readinessTimeoutMs;
    while (isProcessAlive(current.pid) && Date.now() < deadline) {
      await delay(pollIntervalMs);
    }
    if (isProcessAlive(current.pid)) throw new Error(`Web process ${current.pid} did not stop before the timeout`);
    removePidRecord(current.pid);
    return present("stopped", current.pid);
  }

  async function status(): Promise<WebDaemonStatus> {
    const current = readPidRecord(pidFile);
    if (!current) return present("stopped");
    if (!isProcessAlive(current.pid)) {
      removePidRecord(current.pid);
      return present("stale", current.pid);
    }
    return present((await isReady(current)) ? "running" : "stale", current.pid);
  }

  function present(state: WebDaemonStatus["state"], pid?: number): WebDaemonStatus {
    return { state, ...(pid === undefined ? {} : { pid }), url, logFile };
  }

  async function isReady(record: WebPidRecord): Promise<boolean> {
    if (record.host !== options.host || record.port !== options.port) return false;
    return isEndpointReady();
  }

  async function isEndpointReady(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), readinessProbeTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.status >= 200 && response.status < 500;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function waitForReady(record: WebPidRecord, readChildError: () => unknown = () => undefined): Promise<void> {
    const deadline = Date.now() + readinessTimeoutMs;
    while (Date.now() < deadline) {
      const childError = readChildError();
      if (childError !== undefined) {
        throw new Error(`Web process failed during startup: ${errorMessage(childError)}`, { cause: childError });
      }
      if (!isProcessAlive(record.pid)) throw new Error("Web process exited during startup");
      if (await isReady(record)) return;
      await delay(pollIntervalMs);
    }
    throw new Error("Web readiness probe timed out");
  }

  function writePidRecord(record: WebPidRecord): void {
    mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
    const temporaryPath = `${pidFile}.tmp-${process.pid}-${randomUUID()}`;
    let operationError: unknown;
    let operationFailed = false;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, pidFile);
      chmodSync(pidFile, 0o600);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let cleanupError: unknown;
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) cleanupError = error;
    }
    if (operationFailed) throw operationError;
    if (cleanupError !== undefined) throw cleanupError;
  }

  function removePidRecord(expectedPid: number): void {
    const current = readPidRecord(pidFile);
    if (current?.pid !== expectedPid) return;
    try {
      unlinkSync(pidFile);
    } catch (error) {
      if (!isErrorCode(error, "ENOENT")) throw error;
    }
  }

  function validateOptions(): void {
    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
      throw new Error(`Web port must be between 1 and 65535: ${options.port}`);
    }
    if (!options.command.trim()) throw new Error("Web command is required");
  }
}

async function withStartLock<Result>(operation: () => Promise<Result>, lockDirectory: string): Promise<Result> {
  const deadline = Date.now() + startLockTimeoutMs;
  while (true) {
    let acquired = false;
    try {
      mkdirSync(lockDirectory, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (!isErrorCode(error, "EEXIST")) throw error;
    }
    if (acquired) {
      try {
        return await operation();
      } finally {
        rmSync(lockDirectory, { recursive: true, force: true });
      }
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for Web lifecycle lock: ${lockDirectory}`);
    await delay(pollIntervalMs);
  }
}

function readPidRecord(path: string): WebPidRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw new Error(`Web PID record could not be read: ${path}`, { cause: error });
  }
  if (!isWebPidRecord(value)) throw new Error(`Web PID record has an invalid format: ${path}`);
  return value;
}

function isWebPidRecord(value: unknown): value is WebPidRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.host === "string" &&
    typeof record.port === "number" &&
    Number.isInteger(record.port) &&
    typeof record.command === "string" &&
    Array.isArray(record.args) &&
    record.args.every((argument) => typeof argument === "string") &&
    typeof record.startedAt === "string"
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function terminate(pid: number): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
    else process.kill(pid, "SIGTERM");
  } catch (error) {
    if (!isErrorCode(error, "ESRCH")) throw error;
  }
}

function closeDescriptor(descriptor: number): void {
  try {
    closeSync(descriptor);
  } catch {
    // The child process owns the descriptor after spawn. Closing it is best effort.
  }
}

function displayHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
