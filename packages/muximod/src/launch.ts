import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  DaemonEnsureResult,
  DaemonOptions,
  DaemonPidRecord,
  DaemonRestartResult,
  DaemonStartResult,
  DaemonStatusResult,
  DaemonStopResult,
  ProcessResult,
  StartDaemonInput,
} from "@muximo/application";
import {
  type DaemonProcessHandle,
  type DaemonRuntimePort,
  EnsureDaemon,
  RestartDaemon,
  StartDaemon,
  StatusDaemon,
  StopDaemon,
} from "@muximo/application";
import { z } from "zod";
import {
  consumeMuximodRestartMarker,
  hasMuximodRestartMarker,
  readMuximodPidRecord,
  removeMuximodPidRecord,
  removeMuximodRestartMarker,
  writeMuximodPidRecord,
  writeMuximodRestartMarker,
} from "./process-files.js";

const bootstrapEnvironmentName = "MUXIMO_MUXIMOD_BOOTSTRAP";
const bootstrapLockTimeoutMs = 15_000;
const bootstrapPollIntervalMs = 25;
const bootstrapWaitBuffer = new Int32Array(new SharedArrayBuffer(4));
const lifecycleTimeoutMs = 5_000;

export const muximodConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    instanceDirectory: z.string().min(1),
    databaseFile: z.string().min(1),
    hookOutputDirectory: z.string().min(1),
    pidFile: z.string().min(1),
    controlSocket: z.string().min(1),
    muximodBaseUrl: z.string().url(),
    allowedOrigins: z.array(z.string().url()),
    allowedRoots: z.array(z.string().min(1)),
    logLevel: z.enum(["error", "warn", "info", "debug"]),
    logFile: z.string().min(1).optional(),
    workingDirectory: z.string().min(1),
    authSweepIntervalMs: z.number().int().min(1).optional(),
    tmuxPollIntervalMs: z.number().int().min(1).optional(),
    paneCleanupIntervalMs: z.number().int().min(1).optional(),
    paneRetentionMs: z.number().int().min(0).optional(),
  })
  .strict();

export type MuximodConfig = z.infer<typeof muximodConfigSchema>;

export type MuximodLaunchOptions =
  | {
      schemaMode: "migrate";
      config: MuximodConfig;
    }
  | {
      schemaMode: "push";
      config: MuximodConfig;
      baseInstanceDir: string;
    };

export type MuximodProcessResult = ProcessResult & { pid?: number };

export type MuximodProcessHandle = {
  pid?: number;
  wait(): Promise<MuximodProcessResult>;
  terminate(signal?: "SIGINT" | "SIGTERM"): void;
};

export type MuximodLifecycle = {
  ensure(input: DaemonOptions): Promise<DaemonEnsureResult>;
  startForeground(input: DaemonOptions): Promise<MuximodProcessHandle>;
  start(input: StartDaemonInput): Promise<DaemonStartResult>;
  status(input: DaemonOptions): Promise<DaemonStatusResult>;
  stop(input: DaemonOptions): Promise<DaemonStopResult>;
  restart(input: DaemonOptions): Promise<DaemonRestartResult>;
};

export type MuximodLifecycleOptions = {
  schemaMode?: "migrate" | "push";
  baseInstanceDir?: string;
  resolveConfig: (options: DaemonOptions) => MuximodConfig;
};

/**
 * Starts a private muximod child process from a typed launch configuration.
 * The bootstrap payload is an internal process-boundary serialization; it is
 * not a public CLI or user-facing environment contract.
 */
export function spawnMuximod(
  options: MuximodLaunchOptions,
  processOptions: { detached?: boolean; stdio?: "ignore" | "inherit"; environment?: NodeJS.ProcessEnv } = {},
): MuximodProcessHandle {
  if (options.schemaMode === "push") {
    ensureMuximodSnapshot({
      baseInstanceDir: options.baseInstanceDir,
      targetInstanceDir: options.config.instanceDirectory,
      targetDatabaseFile: options.config.databaseFile,
    });
  }

  const processCommand = resolveMuximodProcess();
  const child = spawn(processCommand.executable, processCommand.args, {
    cwd: options.config.workingDirectory,
    detached: processOptions.detached ?? false,
    env: {
      ...(processOptions.environment ?? process.env),
      [bootstrapEnvironmentName]: JSON.stringify(options),
    },
    stdio: processOptions.stdio ?? (processOptions.detached ? "ignore" : "inherit"),
  });
  if (processOptions.detached) child.unref();

  const waitForExit = new Promise<MuximodProcessResult>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) =>
      resolvePromise({ code: code ?? signalExitCode(signal), interrupted: false, signal, pid: child.pid }),
    );
  });
  if (processOptions.detached) {
    // Background lifecycle callers only retain the PID and cannot observe the
    // wait promise. Keep an asynchronous spawn error from becoming unhandled.
    void waitForExit.catch(() => undefined);
  }

  return {
    pid: child.pid,
    wait: () => waitForExit,
    terminate: (signal = "SIGTERM") => {
      if (processOptions.detached && process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch (error) {
          if (!hasErrorCode(error, "ESRCH")) throw error;
        }
      }
      child.kill(signal);
    },
  };
}

/** Creates the CLI-facing daemon lifecycle bound to one schema mode. */
export function createMuximodLifecycle(options: MuximodLifecycleOptions): MuximodLifecycle {
  const schemaMode = options.schemaMode ?? "migrate";
  const baseInstanceDir = options.baseInstanceDir;
  if (schemaMode === "push" && !baseInstanceDir) {
    throw new Error("push schema mode requires a base muximod instance directory");
  }

  const runtime = new MuximodRuntime({
    schemaMode,
    baseInstanceDir,
    resolveConfig: options.resolveConfig,
  });
  const timing = { runtime, clock: systemClock, scheduler: systemScheduler, lifecycleTimeoutMs };
  const ensure = new EnsureDaemon(timing);
  const stop = new StopDaemon(timing);
  const start = new StartDaemon({ ...timing, ensure });
  const status = new StatusDaemon(timing);
  const restart = new RestartDaemon({ ...timing, stop });
  return {
    ensure: (input) => ensure.execute(input),
    startForeground: (input) => runtime.startForeground(input),
    start: (input) => start.execute(input),
    status: (input) => status.execute(input),
    stop: (input) => stop.execute(input),
    restart: (input) => restart.execute(input),
  };
}

/** Full, lossless snapshot bootstrap for a worktree muximod instance. */
export function ensureMuximodSnapshot(input: {
  baseInstanceDir: string;
  targetInstanceDir: string;
  targetDatabaseFile: string;
  snapshot?: (sourceDatabaseFile: string, targetDatabaseFile: string) => void;
}): void {
  const targetDatabaseFile = resolve(input.targetDatabaseFile);
  const baseInstanceDir = resolve(input.baseInstanceDir);
  const targetInstanceDir = resolve(input.targetInstanceDir);
  const sourceDatabaseFile = join(baseInstanceDir, "muximod.sqlite");
  if (sourceDatabaseFile === targetDatabaseFile || baseInstanceDir === targetInstanceDir) {
    throw new Error("base and target muximod instances must be different");
  }
  if (existsSync(targetDatabaseFile)) return;
  if (!existsSync(sourceDatabaseFile)) {
    throw new Error(`base muximod database was not found: ${sourceDatabaseFile}`);
  }

  mkdirSync(targetInstanceDir, { recursive: true, mode: 0o700 });
  chmodSync(targetInstanceDir, 0o700);
  const lockFile = join(targetInstanceDir, "muximod.sqlite.bootstrap.lock");

  while (!existsSync(targetDatabaseFile)) {
    const lockHandle = tryAcquireBootstrapLock(lockFile);
    if (lockHandle === undefined) {
      waitForBootstrap(targetDatabaseFile, lockFile);
      continue;
    }

    try {
      if (existsSync(targetDatabaseFile)) return;
      const temporaryDirectory = mkdtempSync(join(targetInstanceDir, ".muximod-bootstrap-"));
      const temporaryDatabaseFile = join(temporaryDirectory, basename(targetDatabaseFile));
      try {
        (input.snapshot ?? snapshotSqliteDatabase)(sourceDatabaseFile, temporaryDatabaseFile);
        verifySqliteDatabase(temporaryDatabaseFile);
        chmodSync(temporaryDatabaseFile, 0o600);
        try {
          linkSync(temporaryDatabaseFile, targetDatabaseFile);
          chmodSync(targetDatabaseFile, 0o600);
        } catch (error) {
          if (!hasErrorCode(error, "EEXIST")) throw error;
        }
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      return;
    } finally {
      releaseBootstrapLock(lockHandle, lockFile);
    }
  }
}

export function snapshotSqliteDatabase(sourceDatabaseFile: string, targetDatabaseFile: string): void {
  const source = new Database(sourceDatabaseFile);
  try {
    source.exec(`PRAGMA busy_timeout = 1000; VACUUM INTO '${quoteSqlString(targetDatabaseFile)}';`);
  } finally {
    source.close();
  }
}

export function parseMuximodBootstrap(value: string | undefined): MuximodLaunchOptions {
  if (!value) throw new Error(`${bootstrapEnvironmentName} is required for the private muximod process`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid ${bootstrapEnvironmentName} payload`, { cause: error });
  }
  const schema = z.discriminatedUnion("schemaMode", [
    z.object({ schemaMode: z.literal("migrate"), config: muximodConfigSchema }).strict(),
    z
      .object({ schemaMode: z.literal("push"), config: muximodConfigSchema, baseInstanceDir: z.string().min(1) })
      .strict(),
  ]);
  return schema.parse(parsed);
}

function resolveMuximodProcess(): { executable: string; args: string[] } {
  const sourceEntry = fileURLToPath(new URL("./process-entrypoint.ts", import.meta.url));
  if (existsSync(sourceEntry)) return { executable: process.execPath, args: [sourceEntry] };

  const builtEntry = fileURLToPath(new URL("./process-entrypoint.js", import.meta.url));
  if (existsSync(builtEntry)) return { executable: process.execPath, args: [builtEntry] };

  const privateExecutable = join(dirname(process.execPath), privateExecutableName(process.execPath));
  if (existsSync(privateExecutable)) return { executable: privateExecutable, args: [] };

  throw new Error(`private muximod process was not found next to ${process.execPath}`);
}

function privateExecutableName(executable: string): string {
  const extension = process.platform === "win32" ? ".exe" : "";
  const name = basename(executable).replace(/\.exe$/u, "");
  const privateName = name.replace(/^muximo(?=-|$)/u, "muximod");
  return `${privateName === name && name !== "muximod" ? "muximod" : privateName}${extension}`;
}

class MuximodRuntime implements DaemonRuntimePort {
  public constructor(
    private readonly options: {
      schemaMode: "migrate" | "push";
      baseInstanceDir?: string;
      resolveConfig: (options: DaemonOptions) => MuximodConfig;
    },
  ) {}

  public async startForeground(options: DaemonOptions): Promise<MuximodProcessHandle> {
    const handle = this.createForegroundHandle(options);
    const ready = await this.waitForHealthy(options.host, options.port);
    if (!ready) {
      handle.terminate("SIGTERM");
      void handle.wait().catch(() => undefined);
      throw new Error(`muximod did not become healthy within ${lifecycleTimeoutMs}ms`);
    }
    return handle;
  }

  public async runForeground(options: DaemonOptions): Promise<ProcessResult> {
    const handle = await this.startForeground(options);
    return handle.wait();
  }

  private createForegroundHandle(options: DaemonOptions): MuximodProcessHandle {
    const handle = spawnMuximod(this.launchOptions(options), { stdio: "inherit" });
    const forwardSignal = () => handle.terminate("SIGTERM");
    process.once("SIGINT", forwardSignal);
    process.once("SIGTERM", forwardSignal);
    const wait = handle.wait().finally(() => {
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
    });
    return { ...handle, wait: () => wait };
  }

  public spawn(options: DaemonOptions): DaemonProcessHandle {
    const handle = spawnMuximod(this.launchOptions(options), {
      detached: true,
      stdio: "ignore",
    });
    return { pid: handle.pid, terminate: () => handle.terminate() };
  }

  public async isHealthy(host: string, port: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    try {
      const response = await fetch(`http://${displayHost(host)}:${port}/health`, { signal: controller.signal });
      if (!response.ok) return false;
      const body = (await response.json()) as { ok?: boolean; service?: string };
      return body.ok === true && body.service === "muximod";
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitForHealthy(host: string, port: number): Promise<boolean> {
    const deadline = Date.now() + lifecycleTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy(host, port)) return true;
      await systemScheduler.sleep(50);
    }
    return this.isHealthy(host, port);
  }

  public isAlive(pid: number): Promise<boolean> {
    return Promise.resolve(isProcessAlive(pid));
  }

  public signal(pid: number, signal: "SIGTERM"): void {
    process.kill(pid, signal);
  }

  public readPidRecord(path: string): DaemonPidRecord | undefined {
    return readMuximodPidRecord(path);
  }

  public writePidRecord(path: string, record: DaemonPidRecord): void {
    writeMuximodPidRecord(path, record);
  }

  public removePidRecord(path: string, expectedPid: number): void {
    removeMuximodPidRecord(path, expectedPid);
  }

  public writeRestartMarker(pidFile: string, refreshServers: boolean): void {
    writeMuximodRestartMarker(pidFile, refreshServers);
  }

  public hasRestartMarker(pidFile: string): boolean {
    return hasMuximodRestartMarker(pidFile);
  }

  public consumeRestartMarker(pidFile: string): boolean | undefined {
    return consumeMuximodRestartMarker(pidFile);
  }

  public removeRestartMarker(pidFile: string): void {
    removeMuximodRestartMarker(pidFile);
  }

  private launchOptions(options: DaemonOptions): MuximodLaunchOptions {
    const config = muximodConfigSchema.parse(this.options.resolveConfig(options));
    if (this.options.schemaMode !== "push") return { schemaMode: "migrate", config };
    const baseInstanceDir = this.options.baseInstanceDir;
    if (!baseInstanceDir) throw new Error("push schema mode requires a base muximod instance directory");
    return { schemaMode: "push", config, baseInstanceDir };
  }
}

export const systemClock = { now: () => Date.now() };
export const systemScheduler = {
  sleep: (milliseconds: number) => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
};

export function muximodRestartMarkerPath(pidFile: string): string {
  return `${pidFile}.restart`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function tryAcquireBootstrapLock(lockFile: string): number | undefined {
  try {
    return openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return undefined;
    throw error;
  }
}

function waitForBootstrap(databaseFile: string, lockFile: string): void {
  const deadline = Date.now() + bootstrapLockTimeoutMs;
  while (existsSync(lockFile) && !existsSync(databaseFile)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for muximod state bootstrap lock: ${lockFile}`);
    Atomics.wait(bootstrapWaitBuffer, 0, 0, bootstrapPollIntervalMs);
  }
}

function releaseBootstrapLock(lockHandle: number, lockFile: string): void {
  closeSync(lockHandle);
  try {
    unlinkSync(lockFile);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

function verifySqliteDatabase(databaseFile: string): void {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const result = database.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    if (result?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed for ${databaseFile}: ${result?.integrity_check ?? "unknown"}`);
    }
  } finally {
    database.close();
  }
}

function quoteSqlString(value: string): string {
  return value.replaceAll("'", "''");
}

function displayHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
