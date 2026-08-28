import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import { muximodHealthSchema } from "@muximo/contract/api";
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

const legacyBootstrapEnvironmentName = "MUXIMO_MUXIMOD_BOOTSTRAP";
const bootstrapPayloadName = "muximod bootstrap";
const bootstrapFileDescriptor = 3;
const maxBootstrapBytes = 1024 * 1024;
// A lease bounds recovery from a frozen owner. Snapshot writes use a temporary
// file and an atomic hard link, so a second owner can safely finish after the
// lease expires without corrupting the target database.
const bootstrapLockTimeoutMs = 15_000;
const bootstrapPollIntervalMs = 25;
const healthProbeTimeoutMs = 500;
const lifecycleTimeoutMs = 5_000;

const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  }, "URL must use http or https without credentials");
const muximodRuntimeEnvironmentSchema = z
  .object({
    homeDirectory: z.string().min(1).nullable(),
    path: z.string().min(1).nullable(),
    codexHome: z.string().min(1).nullable(),
    claudeConfigDirectory: z.string().min(1).nullable(),
    tailscaleBinary: z.string().min(1).nullable(),
    tmuxPane: z.string().min(1).nullable(),
    tmuxSocket: z.string().min(1).nullable(),
    worktreeId: z.string().min(1).nullable(),
    worktreeRoot: z.string().min(1).nullable(),
    muximoCommand: z.string().min(1).nullable(),
    codexRemote: z.string(),
    codexBinary: z.string().min(1).nullable(),
    claudeBinary: z.string().min(1).nullable(),
    opencodeBinary: z.string().min(1).nullable(),
    migrationsDirectory: z.string().min(1).nullable(),
  })
  .strict();

export const muximodConfigSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    instanceDirectory: z.string().min(1),
    hookOutputDirectory: z.string().min(1),
    pidFile: z.string().min(1),
    controlSocket: z.string().min(1),
    muximodBaseUrl: httpUrlSchema,
    allowedOrigins: z.array(httpUrlSchema),
    allowedRoots: z.array(z.string().min(1)),
    logLevel: z.enum(["error", "warn", "info", "debug"]),
    logFile: z.string().min(1).optional(),
    workingDirectory: z.string().min(1),
    runtimeEnvironment: muximodRuntimeEnvironmentSchema,
    authSweepIntervalMs: z.number().int().min(1).optional(),
    tmuxPollIntervalMs: z.number().int().min(1).optional(),
    paneCleanupIntervalMs: z.number().int().min(1).optional(),
    paneRetentionMs: z.number().int().min(0).optional(),
  })
  .strict();

export type MuximodConfig = z.infer<typeof muximodConfigSchema>;
export type MuximodRuntimeEnvironment = z.infer<typeof muximodRuntimeEnvironmentSchema>;

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

/**
 * Derives the identity of a daemon process from every effective launch
 * setting. The value is public health metadata, so it deliberately excludes
 * credentials and is limited to configuration that clients must agree on.
 */
export function muximodConfigurationFingerprint(options: MuximodLaunchOptions): string {
  const config = normalizeMuximodConfig(options.config);
  const fingerprintInput = {
    schemaMode: options.schemaMode,
    baseInstanceDir: options.schemaMode === "push" ? resolve(config.workingDirectory, options.baseInstanceDir) : null,
    config: {
      host: config.host,
      port: config.port,
      instanceDirectory: resolve(config.instanceDirectory),
      hookOutputDirectory: resolve(config.hookOutputDirectory),
      pidFile: resolve(config.pidFile),
      controlSocket: resolve(config.controlSocket),
      muximodBaseUrl: config.muximodBaseUrl,
      allowedOrigins: [...config.allowedOrigins],
      allowedRoots: config.allowedRoots.map((root) => resolve(root)),
      logLevel: config.logLevel,
      logFile: config.logFile === undefined ? null : resolve(config.logFile),
      workingDirectory: resolve(config.workingDirectory),
      runtimeEnvironment: config.runtimeEnvironment,
      authSweepIntervalMs: config.authSweepIntervalMs ?? null,
      tmuxPollIntervalMs: config.tmuxPollIntervalMs ?? null,
      paneCleanupIntervalMs: config.paneCleanupIntervalMs ?? null,
      paneRetentionMs: config.paneRetentionMs ?? null,
    },
  };
  return createHash("sha256").update(JSON.stringify(fingerprintInput), "utf8").digest("hex");
}

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
  environment?: NodeJS.ProcessEnv;
  resolveConfig: (options: DaemonOptions) => MuximodConfig;
};

/**
 * Starts a private muximod child process from a typed launch configuration.
 * The bootstrap payload is an internal process-boundary serialization; it is
 * passed through a private descriptor rather than exposed in the child
 * process environment. It is not a public CLI or user-facing contract.
 */
export async function spawnMuximod(
  options: MuximodLaunchOptions,
  processOptions: { detached?: boolean; stdio?: "ignore" | "inherit"; environment?: NodeJS.ProcessEnv } = {},
): Promise<MuximodProcessHandle> {
  if (options.schemaMode === "push") {
    await ensureMuximodSnapshot({
      baseInstanceDir: options.baseInstanceDir,
      targetInstanceDir: options.config.instanceDirectory,
      targetDatabaseFile: join(options.config.instanceDirectory, "muximod.sqlite"),
    });
  }

  const processCommand = resolveMuximodProcess();
  const bootstrap = createBootstrapFile(options);
  const stdio = processOptions.stdio ?? (processOptions.detached ? "ignore" : "inherit");
  const childEnvironment: NodeJS.ProcessEnv = { ...(processOptions.environment ?? process.env) };
  delete childEnvironment[legacyBootstrapEnvironmentName];
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(processCommand.executable, processCommand.args, {
      cwd: options.config.workingDirectory,
      detached: processOptions.detached ?? false,
      env: childEnvironment,
      stdio: [stdio, stdio, stdio, bootstrap.fd],
    });
  } catch (error) {
    closeBootstrapFileQuietly(bootstrap);
    throw error;
  }
  try {
    closeBootstrapFile(bootstrap);
  } catch (error) {
    terminateSpawnedChild(child, processOptions.detached ?? false);
    throw new Error("could not clean up the muximod bootstrap descriptor", { cause: error });
  }
  if (processOptions.detached) child.unref();

  let exited = false;
  const waitForExit = new Promise<MuximodProcessResult>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      exited = true;
      resolvePromise({ code: code ?? signalExitCode(signal), interrupted: false, signal, pid: child.pid });
    });
  });
  if (processOptions.detached) {
    // Background lifecycle callers only retain the PID and cannot observe the
    // wait promise. Keep an asynchronous spawn error from becoming unhandled.
    void waitForExit.catch(() => undefined);
  }

  let terminated = false;
  return {
    pid: child.pid,
    wait: () => waitForExit,
    terminate: (signal = "SIGTERM") => {
      if (terminated || exited) return;
      terminated = true;
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
    environment: options.environment ?? process.env,
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
export async function ensureMuximodSnapshot(input: {
  baseInstanceDir: string;
  targetInstanceDir: string;
  targetDatabaseFile: string;
  snapshot?: (sourceDatabaseFile: string, targetDatabaseFile: string) => void | Promise<void>;
}): Promise<void> {
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
    const lock = tryAcquireBootstrapLock(lockFile);
    if (lock === undefined) {
      await waitForBootstrap(targetDatabaseFile, lockFile);
      continue;
    }

    try {
      if (existsSync(targetDatabaseFile)) return;
      const temporaryDirectory = mkdtempSync(join(targetInstanceDir, ".muximod-bootstrap-"));
      const temporaryDatabaseFile = join(temporaryDirectory, basename(targetDatabaseFile));
      try {
        await (input.snapshot ?? snapshotSqliteDatabase)(sourceDatabaseFile, temporaryDatabaseFile);
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
      releaseBootstrapLock(lock.handle, lockFile, lock.token);
    }
  }
}

export function snapshotSqliteDatabase(sourceDatabaseFile: string, targetDatabaseFile: string): void {
  assertSqlitePath(sourceDatabaseFile);
  assertSqlitePath(targetDatabaseFile);
  const source = new Database(sourceDatabaseFile, { readonly: true });
  try {
    // Bun exposes sqlite3_serialize(), which produces a consistent database
    // image without interpolating a caller-controlled path into SQL.
    writeFileSync(targetDatabaseFile, source.serialize("main"), { mode: 0o600 });
  } finally {
    source.close();
  }
}

export function parseMuximodBootstrap(value: string | undefined): MuximodLaunchOptions {
  if (!value) throw new Error(`${bootstrapPayloadName} is required for the private muximod process`);
  if (Buffer.byteLength(value, "utf8") > maxBootstrapBytes) {
    throw new Error(`${bootstrapPayloadName} payload exceeds ${maxBootstrapBytes} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`invalid ${bootstrapPayloadName} payload`, { cause: error });
  }
  const schema = z.discriminatedUnion("schemaMode", [
    z.object({ schemaMode: z.literal("migrate"), config: muximodConfigSchema }).strict(),
    z
      .object({ schemaMode: z.literal("push"), config: muximodConfigSchema, baseInstanceDir: z.string().min(1) })
      .strict(),
  ]);
  return schema.parse(parsed);
}

export function readMuximodBootstrap(fd = bootstrapFileDescriptor): MuximodLaunchOptions {
  let value: string;
  try {
    value = readBootstrapDescriptor(fd);
  } catch (error) {
    throw new Error(`could not read muximod bootstrap descriptor ${fd}`, { cause: error });
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The descriptor may already have been closed by the runtime.
    }
  }
  return parseMuximodBootstrap(value);
}

function createBootstrapFile(options: MuximodLaunchOptions): { directory: string; path: string; fd: number } {
  const directory = mkdtempSync(join(tmpdir(), "muximod-bootstrap-"));
  chmodSync(directory, 0o700);
  const path = join(directory, "options.json");
  const contents = JSON.stringify(options);
  if (Buffer.byteLength(contents, "utf8") > maxBootstrapBytes) {
    rmSync(directory, { recursive: true, force: true });
    throw new Error(`${bootstrapPayloadName} payload exceeds ${maxBootstrapBytes} bytes`);
  }
  let writeFd: number | undefined;
  try {
    writeFd = openSync(path, "wx", 0o600);
    writeFileSync(writeFd, contents, { encoding: "utf8" });
    closeSync(writeFd);
    writeFd = undefined;
    const fd = openSync(path, "r");
    return { directory, path, fd };
  } catch (error) {
    if (writeFd !== undefined) closeSync(writeFd);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function readBootstrapDescriptor(fd: number): string {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  while (true) {
    const chunk = Buffer.alloc(Math.min(64 * 1024, maxBootstrapBytes + 1 - totalBytes));
    const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    totalBytes += bytesRead;
    chunks.push(chunk.subarray(0, bytesRead));
    if (totalBytes > maxBootstrapBytes) {
      throw new Error(`${bootstrapPayloadName} payload exceeds ${maxBootstrapBytes} bytes`);
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

function closeBootstrapFile(bootstrap: { directory: string; path: string; fd: number }): void {
  const cleanupErrors: unknown[] = [];
  try {
    closeSync(bootstrap.fd);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    unlinkSync(bootstrap.path);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) cleanupErrors.push(error);
  }
  try {
    rmSync(bootstrap.directory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
}

function closeBootstrapFileQuietly(bootstrap: { directory: string; path: string; fd: number }): void {
  try {
    closeBootstrapFile(bootstrap);
  } catch {
    // Preserve the original spawn failure. The temporary directory is private
    // and will be reclaimed by the operating system's temporary-file cleanup.
  }
}

function terminateSpawnedChild(child: ReturnType<typeof spawn>, detached: boolean): void {
  if (detached && process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch (error) {
      if (hasErrorCode(error, "ESRCH")) return;
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // The child may have exited while the bootstrap descriptor was cleaned up.
  }
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
      environment: NodeJS.ProcessEnv;
      resolveConfig: (options: DaemonOptions) => MuximodConfig;
    },
  ) {}

  public async startForeground(options: DaemonOptions): Promise<MuximodProcessHandle> {
    const handle = await this.createForegroundHandle(options);
    try {
      const ready = await this.waitForHealthy(options, handle.pid);
      if (ready) return handle;
      throw new Error(`muximod did not become healthy within ${lifecycleTimeoutMs}ms`);
    } catch (error) {
      try {
        handle.terminate("SIGTERM");
      } catch {
        // The process may have exited between the health check and cleanup.
      }
      await handle.wait().catch(() => undefined);
      throw error;
    }
  }

  public async runForeground(options: DaemonOptions): Promise<ProcessResult> {
    const handle = await this.startForeground(options);
    return handle.wait();
  }

  private async createForegroundHandle(options: DaemonOptions): Promise<MuximodProcessHandle> {
    const handle = await spawnMuximod(this.launchOptions(options), {
      stdio: "inherit",
      environment: this.options.environment,
    });
    let terminated = false;
    let signalsCleaned = false;
    const cleanupSignals = () => {
      if (signalsCleaned) return;
      signalsCleaned = true;
      process.off("SIGINT", forwardSignal);
      process.off("SIGTERM", forwardSignal);
    };
    const forwardSignal = () => {
      if (terminated) return;
      terminated = true;
      cleanupSignals();
      handle.terminate("SIGTERM");
    };
    process.once("SIGINT", forwardSignal);
    process.once("SIGTERM", forwardSignal);
    const wait = handle.wait().finally(() => {
      terminated = true;
      cleanupSignals();
    });
    return {
      ...handle,
      wait: () => wait,
      terminate: (signal = "SIGTERM") => {
        if (terminated) return;
        terminated = true;
        cleanupSignals();
        handle.terminate(signal);
      },
    };
  }

  public async spawn(options: DaemonOptions): Promise<DaemonProcessHandle> {
    const handle = await spawnMuximod(this.launchOptions(options), {
      detached: true,
      stdio: "ignore",
      environment: this.options.environment,
    });
    let terminated = false;
    return {
      pid: handle.pid,
      terminate: () => {
        if (terminated) return;
        terminated = true;
        handle.terminate();
      },
    };
  }

  public async isHealthy(options: DaemonOptions, expectedPid?: number): Promise<boolean> {
    const launchOptions = this.launchOptions(options);
    const configurationFingerprint = muximodConfigurationFingerprint(launchOptions);
    return this.probeHealthy(options.host, options.port, expectedPid, configurationFingerprint, healthProbeTimeoutMs);
  }

  private async probeHealthy(
    host: string,
    port: number,
    expectedPid: number | undefined,
    configurationFingerprint: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await fetch(`http://${displayHost(host)}:${port}/health`, { signal: controller.signal });
      if (!response.ok) return false;
      const parsed = muximodHealthSchema.safeParse(await response.json());
      return (
        parsed.success &&
        parsed.data.configurationFingerprint === configurationFingerprint &&
        (expectedPid === undefined || parsed.data.pid === expectedPid)
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async waitForHealthy(options: DaemonOptions, expectedPid?: number): Promise<boolean> {
    const launchOptions = this.launchOptions(options);
    const configurationFingerprint = muximodConfigurationFingerprint(launchOptions);
    const deadline = systemClock.now() + lifecycleTimeoutMs;
    while (true) {
      const remainingMs = deadline - systemClock.now();
      if (remainingMs <= 0) return false;
      if (
        await this.probeHealthy(
          options.host,
          options.port,
          expectedPid,
          configurationFingerprint,
          Math.min(healthProbeTimeoutMs, remainingMs),
        )
      )
        return true;
      const sleepMs = Math.min(bootstrapPollIntervalMs, deadline - systemClock.now());
      if (sleepMs <= 0) return false;
      await systemScheduler.sleep(sleepMs);
    }
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
    const config = normalizeMuximodConfig(muximodConfigSchema.parse(this.options.resolveConfig(options)));
    if (this.options.schemaMode !== "push") return { schemaMode: "migrate", config };
    const baseInstanceDir = this.options.baseInstanceDir;
    if (!baseInstanceDir) throw new Error("push schema mode requires a base muximod instance directory");
    return { schemaMode: "push", config, baseInstanceDir: resolve(config.workingDirectory, baseInstanceDir) };
  }
}

function normalizeMuximodConfig(config: MuximodConfig): MuximodConfig {
  const workingDirectory = resolve(config.workingDirectory);
  const resolvePath = (value: string) => resolve(workingDirectory, value);
  return {
    ...config,
    instanceDirectory: resolvePath(config.instanceDirectory),
    hookOutputDirectory: resolvePath(config.hookOutputDirectory),
    pidFile: resolvePath(config.pidFile),
    controlSocket: resolvePath(config.controlSocket),
    allowedRoots: config.allowedRoots.map(resolvePath),
    ...(config.logFile === undefined ? {} : { logFile: resolvePath(config.logFile) }),
    workingDirectory,
    runtimeEnvironment: {
      ...config.runtimeEnvironment,
      ...(config.runtimeEnvironment.migrationsDirectory === null
        ? {}
        : { migrationsDirectory: resolvePath(config.runtimeEnvironment.migrationsDirectory) }),
    },
  };
}

/** Monotonic lifecycle time; persisted/user-facing timestamps use Date separately. */
export const systemClock = { now: () => performance.now() };
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
  } catch {
    // A muximod child is owned by the invoking account. EPERM therefore means
    // that the PID is not signalable by this lifecycle, so treat the record as
    // stale instead of blocking a new daemon behind an unrelated PID.
    return false;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function tryAcquireBootstrapLock(lockFile: string): { handle: number; token: string } | undefined {
  const token = randomUUID();
  try {
    const handle = openSync(lockFile, "wx", 0o600);
    try {
      writeFileSync(handle, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token }), {
        encoding: "utf8",
      });
      chmodSync(lockFile, 0o600);
      return { handle, token };
    } catch (error) {
      closeSync(handle);
      try {
        unlinkSync(lockFile);
      } catch {
        // Preserve the lock creation failure.
      }
      throw error;
    }
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return undefined;
    throw error;
  }
}

async function waitForBootstrap(databaseFile: string, lockFile: string): Promise<void> {
  while (existsSync(lockFile) && !existsSync(databaseFile)) {
    if (reclaimStaleBootstrapLock(lockFile)) return;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, bootstrapPollIntervalMs));
  }
}

function reclaimStaleBootstrapLock(lockFile: string): boolean {
  if (!existsSync(lockFile)) return false;
  let ageMs: number;
  try {
    ageMs = Math.max(0, Date.now() - statSync(lockFile).mtimeMs);
  } catch {
    return false;
  }
  let contents: string;
  try {
    const descriptor = openSync(lockFile, "r");
    try {
      const buffer = Buffer.alloc(1024);
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
      contents = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return ageMs >= bootstrapLockTimeoutMs && unlinkBootstrapLock(lockFile);
  }
  if (!isBootstrapLockRecord(parsed)) {
    return ageMs >= bootstrapLockTimeoutMs && unlinkBootstrapLock(lockFile);
  }
  if (isProcessAlive(parsed.pid) && ageMs < bootstrapLockTimeoutMs) return false;

  return unlinkBootstrapLock(lockFile);
}

function unlinkBootstrapLock(lockFile: string): boolean {
  try {
    unlinkSync(lockFile);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return true;
    return false;
  }
}

function isBootstrapLockRecord(value: unknown): value is { pid: number; acquiredAt: string; token: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).sort().join(",") === "acquiredAt,pid,token" &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.acquiredAt === "string" &&
    Number.isFinite(Date.parse(record.acquiredAt)) &&
    new Date(record.acquiredAt).toISOString() === record.acquiredAt &&
    typeof record.token === "string" &&
    record.token.length > 0
  );
}

function releaseBootstrapLock(lockHandle: number, lockFile: string, token: string): void {
  closeSync(lockHandle);
  let contents: string;
  try {
    contents = readFileSync(lockFile, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return;
    throw error;
  }
  let record: unknown;
  try {
    record = JSON.parse(contents);
  } catch {
    // A replacement owner may have taken the lock after this process was
    // reclaimed. Never remove an unrecognized replacement lock.
    return;
  }
  if (!isBootstrapLockRecord(record) || record.token !== token) return;
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

function assertSqlitePath(value: string): void {
  if (value.includes("\u0000")) throw new Error("SQLite snapshot paths must not contain NUL bytes");
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
