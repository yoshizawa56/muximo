import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type {
  DaemonClock,
  DaemonOptions,
  DaemonPidRecord,
  DaemonProcessHandle,
  DaemonRuntimePort,
  DaemonScheduler,
  ProcessResult,
} from "@muximo/application";
import { defaultLogFile } from "../logging/index.js";
import { isProcessAlive, signalExitCode } from "./process.js";

export type MuximodDaemonProcessOptions = {
  environment?: NodeJS.ProcessEnv;
  executable?: string;
  args?: readonly string[];
  run?: (executable: string, args: readonly string[], environment: NodeJS.ProcessEnv) => Promise<ProcessResult>;
};

/** OS process, pid-file, health, and environment adapter for muximod. */
export class MuximodDaemonProcess implements DaemonRuntimePort {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly executable: string;
  private readonly executableArgs: readonly string[];
  private readonly runProcess: NonNullable<MuximodDaemonProcessOptions["run"]>;

  public constructor(options: MuximodDaemonProcessOptions = {}) {
    this.environment = { ...process.env, ...options.environment };
    const command = options.executable
      ? { executable: options.executable, args: options.args ?? [] }
      : this.environment.MUXIMO_MUXIMOD_BIN
        ? { executable: this.environment.MUXIMO_MUXIMOD_BIN, args: options.args ?? [] }
        : resolveBundledMuximod();
    this.executable = command.executable;
    this.executableArgs = command.args;
    this.runProcess = options.run ?? runAttached;
  }

  public runForeground(options: DaemonOptions): Promise<ProcessResult> {
    return this.runProcess(
      this.executable,
      this.executableArgs,
      buildMuximodServerEnvironment(options, this.environment),
    );
  }

  public spawn(options: DaemonOptions): DaemonProcessHandle {
    const child = spawn(this.executable, [...this.executableArgs], {
      cwd: process.cwd(),
      detached: true,
      env: buildMuximodServerEnvironment(options, this.environment),
      stdio: "ignore",
    });
    child.unref();
    return {
      pid: child.pid,
      terminate: (signal) => child.kill(signal),
    };
  }

  public async isHealthy(host: string, port: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      const response = await fetch(`http://${displayMuximodHost(host)}:${port}/health`, {
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { ok?: boolean; service?: string };
      return body.ok === true && body.service === "muximod";
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  public isAlive(pid: number): Promise<boolean> {
    return Promise.resolve(isProcessAlive(pid));
  }

  public signal(pid: number, signal: "SIGTERM"): void {
    process.kill(pid, signal);
  }

  public readPidRecord(path: string): DaemonPidRecord | undefined {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) return undefined;
      throw new Error(`muximod pid file could not be read: ${path}`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`muximod pid file contains invalid JSON: ${path}`, { cause: error });
    }
    if (!isDaemonPidRecord(parsed)) {
      throw new Error(`muximod pid file has an invalid format: ${path}`);
    }
    return parsed;
  }

  public writePidRecord(path: string, record: DaemonPidRecord): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }

  public removePidRecord(path: string, expectedPid: number): void {
    const record = this.readPidRecord(path);
    if (record?.pid !== expectedPid) return;
    try {
      unlinkSync(path);
    } catch {
      // Another lifecycle operation may have removed the record already.
    }
  }

  public writeRestartMarker(pidFile: string, refreshServers: boolean): void {
    const path = restartMarkerPath(pidFile);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid, refreshServers, startedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
  }

  public hasRestartMarker(pidFile: string): boolean {
    return existsSync(restartMarkerPath(pidFile));
  }

  public consumeRestartMarker(pidFile: string): boolean | undefined {
    const path = restartMarkerPath(pidFile);
    if (!existsSync(path)) return undefined;
    let refreshServers: boolean;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (!isRestartMarkerRecord(parsed)) throw new Error("restart marker does not match the current format");
      refreshServers = parsed.refreshServers;
    } catch (error) {
      try {
        unlinkSync(path);
      } catch {
        // The marker may already have been removed while it was being read.
      }
      throw new Error(`muximod restart marker has an invalid format: ${path}`, { cause: error });
    }
    try {
      unlinkSync(path);
    } catch {
      // The marker may already have been removed; its presence already signaled a restart.
    }
    return refreshServers;
  }

  public removeRestartMarker(pidFile: string): void {
    try {
      unlinkSync(restartMarkerPath(pidFile));
    } catch {
      // No marker to remove.
    }
  }
}

export const systemDaemonClock: DaemonClock = {
  now: () => Date.now(),
};

export const systemDaemonScheduler: DaemonScheduler = {
  sleep: (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
};

export function restartMarkerPath(pidFile: string): string {
  return `${pidFile}.restart`;
}

function isDaemonPidRecord(value: unknown): value is DaemonPidRecord {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== ["host", "pid", "port", "startedAt"].join(",")) return false;
  return (
    isPositiveInteger(value.pid) &&
    typeof value.host === "string" &&
    value.host.length > 0 &&
    isPort(value.port) &&
    typeof value.startedAt === "string" &&
    isIsoTimestamp(value.startedAt)
  );
}

function isRestartMarkerRecord(value: unknown): value is { pid: number; refreshServers: boolean; startedAt: string } {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== ["pid", "refreshServers", "startedAt"].join(",")) return false;
  return (
    isPositiveInteger(value.pid) &&
    typeof value.refreshServers === "boolean" &&
    typeof value.startedAt === "string" &&
    isIsoTimestamp(value.startedAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Builds the child environment; lifecycle commands never become child argv. */
export function buildMuximodServerEnvironment(
  options: DaemonOptions,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const configured = buildMuximodDaemonEnvironment(options, environment);
  return {
    ...configured,
    MUXIMOD_HOST: options.host,
    MUXIMOD_PORT: String(options.port),
    MUXIMOD_PID_FILE: options.pidFile,
    ...(options.controlSocket ? { MUXIMOD_CONTROL_SOCKET: options.controlSocket } : {}),
    ...(options.muximodBaseUrl ? { MUXIMOD_PAIRING_BASE_URL: options.muximodBaseUrl } : {}),
    ...(options.logLevel ? { MUXIMO_LOG_LEVEL: options.logLevel } : {}),
    ...(options.logFile ? { MUXIMO_LOG_FILE: options.logFile } : { MUXIMO_LOG_FILE: defaultLogFile() }),
  };
}

/** Builds the exact browser-origin environment before the server process starts. */
export function buildMuximodDaemonEnvironment(
  input: Pick<DaemonOptions, "allowedOrigins">,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const configured = input.allowedOrigins ?? readConfiguredOrigins(environment.MUXIMOD_ALLOWED_ORIGINS);
  if (configured === undefined) return { ...environment };
  const origins = normalizeAllowedOrigins(configured);
  return {
    ...environment,
    ...(origins.length > 0 ? { MUXIMOD_ALLOWED_ORIGINS: origins.join(",") } : { MUXIMOD_ALLOWED_ORIGINS: undefined }),
  };
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

function readConfiguredOrigins(value: string | undefined): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return value.split(",");
}

function resolveBundledMuximod(): { executable: string; args: readonly string[] } {
  const candidate = join(dirname(process.execPath), "muximod");
  if (existsSync(candidate)) return { executable: candidate, args: [] };

  const sourceEntry = process.argv[1];
  if (basename(process.execPath) === "bun" && sourceEntry) {
    const sourceMuximod = resolve(dirname(sourceEntry), "../../muximod/src/index.ts");
    if (existsSync(sourceMuximod)) return { executable: process.execPath, args: [sourceMuximod] };
  }
  return { executable: "muximod", args: [] };
}

function displayMuximodHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function runAttached(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(executable, [...args], { env: environment, stdio: "inherit" });
    } catch (error) {
      reject(error);
      return;
    }
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolvePromise({ code: code ?? signalExitCode(signal), interrupted: false, signal }),
    );
  });
}
