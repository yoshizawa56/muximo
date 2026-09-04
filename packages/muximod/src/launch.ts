import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
import { sanitizeProcessDiagnostic } from "@muximo/infrastructure/runtime";
import { isLoopbackOrPrivateBindHost } from "@muximo/profile";
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
    host: z
      .string()
      .min(1)
      .refine(isLoopbackOrPrivateBindHost, "host must be localhost, a loopback address, or a private IP address"),
    port: z.number().int().min(1).max(65_535),
    instanceDirectory: z.string().min(1),
    configFile: z.string().min(1),
    hookOutputDirectory: z.string().min(1),
    pidFile: z.string().min(1),
    controlSocket: z.string().min(1),
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
    enabledAgentBackends: z.array(z.enum(["codex", "claude", "opencode"])).optional(),
    defaultAgentBackend: z.enum(["codex", "claude", "opencode"]).nullable().optional(),
  })
  .strict();

export type MuximodConfig = z.infer<typeof muximodConfigSchema>;
export type MuximodRuntimeEnvironment = z.infer<typeof muximodRuntimeEnvironmentSchema>;

export type MuximodLaunchOptions = {
  schemaMode: "migrate" | "push";
  config: MuximodConfig;
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
    config: {
      host: config.host,
      port: config.port,
      instanceDirectory: resolve(config.instanceDirectory),
      configFile: resolve(config.configFile),
      hookOutputDirectory: resolve(config.hookOutputDirectory),
      pidFile: resolve(config.pidFile),
      controlSocket: resolve(config.controlSocket),
      allowedOrigins: [...config.allowedOrigins],
      allowedRoots: config.allowedRoots.map((root) => resolve(root)),
      logLevel: config.logLevel,
      logFile: config.logFile === undefined ? null : resolve(config.logFile),
      workingDirectory: resolve(config.workingDirectory),
      runtimeEnvironment: {
        ...config.runtimeEnvironment,
        // TMUX_PANE identifies the CLI that selected this launch, not the
        // daemon environment. A daemon started from one pane must be reusable
        // by a run invoked from another pane.
        tmuxPane: null,
      },
      enabledAgentBackends: config.enabledAgentBackends ?? null,
      defaultAgentBackend: config.defaultAgentBackend ?? null,
      authSweepIntervalMs: config.authSweepIntervalMs ?? null,
      tmuxPollIntervalMs: config.tmuxPollIntervalMs ?? null,
      paneCleanupIntervalMs: config.paneCleanupIntervalMs ?? null,
      paneRetentionMs: config.paneRetentionMs ?? null,
    },
  };
  return createHash("sha256").update(JSON.stringify(fingerprintInput), "utf8").digest("hex");
}

export type MuximodProcessResult = ProcessResult & { pid?: number };

/** Process command used by the lifecycle adapter to start the private daemon. */
export type MuximodProcessCommand = {
  executable: string;
  args: readonly string[];
};

export type MuximodProcessHandle = {
  pid?: number;
  wait(): Promise<MuximodProcessResult>;
  terminate(signal?: "SIGINT" | "SIGTERM"): void;
};

export type MuximodLifecycle = {
  ensure(input: DaemonOptions): Promise<DaemonEnsureResult>;
  start(input: StartDaemonInput): Promise<DaemonStartResult>;
  status(input: DaemonOptions): Promise<DaemonStatusResult>;
  stop(input: DaemonOptions): Promise<DaemonStopResult>;
  restart(input: DaemonOptions): Promise<DaemonRestartResult>;
};

export type MuximodLifecycleOptions = {
  schemaMode?: "migrate" | "push";
  environment?: NodeJS.ProcessEnv;
  processCommand?: MuximodProcessCommand;
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
  processOptions: {
    detached?: boolean;
    stdio?: "ignore" | "inherit";
    environment?: NodeJS.ProcessEnv;
    processCommand?: MuximodProcessCommand;
  } = {},
): Promise<MuximodProcessHandle> {
  const processCommand = resolveMuximodProcess(processOptions.processCommand);
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
  let processStarted = false;
  const waitForExit = new Promise<MuximodProcessResult>((resolvePromise) => {
    child.once("spawn", () => {
      processStarted = true;
    });
    child.once("error", (error) => {
      exited = true;
      const failureDiagnostic = sanitizeProcessDiagnostic(error instanceof Error ? error.message : String(error));
      resolvePromise({
        started: false,
        code: 127,
        interrupted: false,
        signal: null,
        pid: child.pid,
        ...(failureDiagnostic === undefined ? {} : { failureDiagnostic }),
      });
    });
    child.once("close", (code, signal) => {
      exited = true;
      resolvePromise({
        started: processStarted,
        code: code ?? signalExitCode(signal),
        interrupted: false,
        signal,
        pid: child.pid,
      });
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

  const runtime = new MuximodRuntime({
    schemaMode,
    environment: options.environment ?? process.env,
    processCommand: options.processCommand,
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
    start: (input) => start.execute(input),
    status: (input) => status.execute(input),
    stop: (input) => stop.execute(input),
    restart: (input) => restart.execute(input),
  };
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
  const schema = z.object({ schemaMode: z.enum(["migrate", "push"]), config: muximodConfigSchema }).strict();
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

/** Returns whether the private bootstrap descriptor is an inherited file. */
export function hasMuximodBootstrap(fd = bootstrapFileDescriptor): boolean {
  try {
    return fstatSync(fd).isFile();
  } catch {
    return false;
  }
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

function resolveMuximodProcess(explicitCommand?: MuximodProcessCommand): MuximodProcessCommand {
  if (explicitCommand) return { executable: explicitCommand.executable, args: [...explicitCommand.args] };

  // Development keeps the source process entrypoint for fast iteration. The
  // production launcher injects the current muximo binary explicitly, so a
  // second production executable is never an implicit fallback.
  const sourceEntry = fileURLToPath(new URL("./process-entrypoint.ts", import.meta.url));
  if (existsSync(sourceEntry)) return { executable: process.execPath, args: [sourceEntry] };

  const builtEntry = fileURLToPath(new URL("./process-entrypoint.js", import.meta.url));
  if (existsSync(builtEntry)) return { executable: process.execPath, args: [builtEntry] };

  throw new Error("muximod process entrypoint is unavailable; use the supported muximo launcher");
}

class MuximodRuntime implements DaemonRuntimePort {
  public constructor(
    private readonly options: {
      schemaMode: "migrate" | "push";
      environment: NodeJS.ProcessEnv;
      processCommand?: MuximodProcessCommand;
      resolveConfig: (options: DaemonOptions) => MuximodConfig;
    },
  ) {}

  public isProcessHealthy(options: Pick<DaemonOptions, "host" | "port">, expectedPid: number): Promise<boolean> {
    return this.probeProcessHealth(options.host, options.port, expectedPid);
  }

  private async probeProcessHealth(host: string, port: number, expectedPid: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), healthProbeTimeoutMs);
    try {
      const response = await fetch(`http://${displayHost(host)}:${port}/health`, {
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const parsed = muximodHealthSchema.safeParse(await response.json());
      return parsed.success && parsed.data.pid === expectedPid;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async spawn(options: DaemonOptions): Promise<DaemonProcessHandle> {
    const handle = await spawnMuximod(this.launchOptions(options), {
      detached: true,
      stdio: "ignore",
      environment: this.options.environment,
      processCommand: this.options.processCommand,
    });
    let terminated = false;
    return {
      pid: handle.pid,
      wait: () => handle.wait(),
      terminate: () => {
        if (terminated) return;
        terminated = true;
        handle.terminate();
      },
    };
  }

  public async isHealthy(options: DaemonOptions, expectedPid?: number): Promise<boolean> {
    const requestedLaunchOptions = this.launchOptions(options);
    const record = readMuximodPidRecord(requestedLaunchOptions.config.pidFile);
    if (record && expectedPid !== undefined && record.pid !== expectedPid) {
      const configurationFingerprint = muximodConfigurationFingerprint(requestedLaunchOptions);
      return this.probeHealthy(options.host, options.port, expectedPid, configurationFingerprint, healthProbeTimeoutMs);
    }

    const effectiveOptions = record ? { ...options, host: record.host, port: record.port } : options;
    const launchOptions = record ? this.launchOptions(effectiveOptions) : requestedLaunchOptions;
    const configurationFingerprint = muximodConfigurationFingerprint(launchOptions);
    return this.probeHealthy(
      effectiveOptions.host,
      effectiveOptions.port,
      record?.pid ?? expectedPid,
      configurationFingerprint,
      healthProbeTimeoutMs,
    );
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
    return { schemaMode: this.options.schemaMode, config };
  }
}

function normalizeMuximodConfig(config: MuximodConfig): MuximodConfig {
  const workingDirectory = resolve(config.workingDirectory);
  const resolvePath = (value: string) => resolve(workingDirectory, value);
  return {
    ...config,
    instanceDirectory: resolvePath(config.instanceDirectory),
    configFile: resolvePath(config.configFile),
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
