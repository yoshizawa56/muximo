import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
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
  type ApplicationEffect,
  type DaemonProcessHandle,
  type DaemonRuntimePort,
  EnsureDaemon,
  RestartDaemon,
  StartDaemon,
  StatusDaemon,
  StopDaemon,
} from "@muximo/application";
import { muximodHealthSchema } from "@muximo/contract/api";
import { fromPromise, runEffectAsPromise, sanitizeProcessDiagnostic } from "@muximo/infrastructure/runtime";
import { isLoopbackOrPrivateBindHost } from "@muximo/profile";
import { Effect, Result, Schema } from "effect";
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
const bootstrapPollIntervalMs = 25;
const healthProbeTimeoutMs = 500;
const lifecycleTimeoutMs = 5_000;

const httpUrlSchema = Schema.String.check(
  Schema.makeFilter((value: string) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
    } catch {
      return false;
    }
  }),
);
const nullableIdString = Schema.NullOr(Schema.String.check(Schema.isMinLength(1)));

const positiveDaemonInteger = (minimum: number) =>
  Schema.makeFilter((value: number) => Number.isInteger(value) && value >= minimum);

const nonNegativeDaemonInteger = () => Schema.makeFilter((value: number) => Number.isInteger(value) && value >= 0);

const muximodRuntimeEnvironmentSchema = Schema.Struct({
  homeDirectory: nullableIdString,
  path: nullableIdString,
  codexHome: nullableIdString,
  claudeConfigDirectory: nullableIdString,
  tailscaleBinary: nullableIdString,
  tmuxPane: nullableIdString,
  tmuxSocket: nullableIdString,
  worktreeId: nullableIdString,
  worktreeRoot: nullableIdString,
  muximoCommand: nullableIdString,
  codexRemote: Schema.String,
  codexBinary: nullableIdString,
  claudeBinary: nullableIdString,
  opencodeBinary: nullableIdString,
  migrationsDirectory: nullableIdString,
});

export const muximodConfigSchema = Schema.Struct({
  host: Schema.String.check(
    Schema.isMinLength(1),
    Schema.makeFilter((value: string) =>
      isLoopbackOrPrivateBindHost(value)
        ? undefined
        : "host must be localhost, a loopback address, or a private IP address",
    ),
  ),
  port: Schema.Int.check(
    Schema.makeFilter((value: number) => Number.isInteger(value) && value >= 1 && value <= 65_535),
  ),
  instanceDirectory: Schema.String.check(Schema.isMinLength(1)),
  hookOutputDirectory: Schema.String.check(Schema.isMinLength(1)),
  pidFile: Schema.String.check(Schema.isMinLength(1)),
  controlSocket: Schema.String.check(Schema.isMinLength(1)),
  allowedOrigins: Schema.Array(httpUrlSchema),
  allowedRoots: Schema.Array(Schema.String.check(Schema.isMinLength(1))),
  logLevel: Schema.Literals(["error", "warn", "info", "debug"]),
  logFile: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  workingDirectory: Schema.String.check(Schema.isMinLength(1)),
  runtimeEnvironment: muximodRuntimeEnvironmentSchema,
  authSweepIntervalMs: Schema.optional(Schema.Int.check(positiveDaemonInteger(1))),
  tmuxPollIntervalMs: Schema.optional(Schema.Int.check(positiveDaemonInteger(1))),
  paneCleanupIntervalMs: Schema.optional(Schema.Int.check(positiveDaemonInteger(1))),
  paneRetentionMs: Schema.optional(Schema.Int.check(nonNegativeDaemonInteger())),
});

const decodeMuximodConfig = (input: unknown) =>
  Schema.decodeUnknownSync(muximodConfigSchema, { onExcessProperty: "error" })(input);

export type MuximodConfig = (typeof muximodConfigSchema)["Type"];
export type MuximodRuntimeEnvironment = (typeof muximodRuntimeEnvironmentSchema)["Type"];

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

export type MuximodForegroundConflictPolicy = "reject" | "replace-owned";

export type MuximodLifecycleOptions = {
  schemaMode?: "migrate" | "push";
  foregroundConflictPolicy?: MuximodForegroundConflictPolicy;
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
    foregroundConflictPolicy: options.foregroundConflictPolicy ?? "reject",
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
    ensure: (input) => Effect.runPromise(ensure.execute(input)),
    startForeground: (input) => runtime.startForeground(input),
    start: (input) => Effect.runPromise(start.execute(input)),
    status: (input) => Effect.runPromise(status.execute(input)),
    stop: (input) => Effect.runPromise(stop.execute(input)),
    restart: (input) => Effect.runPromise(restart.execute(input)),
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
  const schema = Schema.Struct({ schemaMode: Schema.Literals(["migrate", "push"]), config: muximodConfigSchema });
  return Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(parsed);
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
      foregroundConflictPolicy: MuximodForegroundConflictPolicy;
      environment: NodeJS.ProcessEnv;
      resolveConfig: (options: DaemonOptions) => MuximodConfig;
    },
  ) {}

  public async startForeground(options: DaemonOptions): Promise<MuximodProcessHandle> {
    await this.prepareForegroundStart(options);
    const handle = await this.createForegroundHandle(options);
    const startupAbort = new AbortController();
    try {
      const outcome = await Promise.race([
        runEffectAsPromise(this.waitForHealthy(options, handle.pid, startupAbort.signal)).then((ready) => ({
          kind: "health" as const,
          ready,
        })),
        handle.wait().then((result) => ({ kind: "exit" as const, result })),
      ]);
      startupAbort.abort();
      if (outcome.kind === "health" && outcome.ready) return handle;
      if (outcome.kind === "exit") throw new MuximodStartupError(outcome.result);
      throw new MuximodStartupError();
    } catch (error) {
      startupAbort.abort();
      try {
        handle.terminate("SIGTERM");
      } catch {
        // The process may have exited between the health check and cleanup.
      }
      await handle.wait().catch(() => undefined);
      throw error;
    }
  }

  private async prepareForegroundStart(options: DaemonOptions): Promise<void> {
    if (this.options.foregroundConflictPolicy !== "replace-owned") return;

    const launchOptions = this.launchOptions(options);
    const pidFile = launchOptions.config.pidFile;
    const record = readMuximodPidRecord(pidFile);
    if (!record) return;
    if (record.pid === process.pid) {
      throw new Error(`cannot replace the current process recorded in ${pidFile}`);
    }
    if (!isProcessAlive(record.pid)) {
      removeMuximodPidRecord(pidFile, record.pid);
      return;
    }

    if (!(await this.probeProcessIdentity(record))) {
      throw new Error(
        `cannot replace muximod process ${record.pid}: ownership could not be verified; stop it with daemon restart`,
      );
    }

    try {
      process.kill(record.pid, "SIGTERM");
    } catch (error) {
      if (!hasErrorCode(error, "ESRCH")) throw error;
    }
    const stopped = await runEffectAsPromise(waitForProcessExit(record.pid, lifecycleTimeoutMs));
    if (!stopped) throw new Error(`muximod process ${record.pid} did not stop before foreground replacement`);
    removeMuximodPidRecord(pidFile, record.pid);
  }

  private async probeProcessIdentity(record: DaemonPidRecord): Promise<boolean> {
    return this.probeProcessHealth(record.host, record.port, record.pid);
  }

  public isProcessHealthy(
    options: Pick<DaemonOptions, "host" | "port">,
    expectedPid: number,
  ): ApplicationEffect<boolean> {
    return fromPromise(() => this.probeProcessHealth(options.host, options.port, expectedPid));
  }

  private async probeProcessHealth(host: string, port: number, expectedPid: number): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), healthProbeTimeoutMs);
    try {
      const response = await fetch(`http://${displayHost(host)}:${port}/health`, {
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const result = Schema.decodeUnknownResult(muximodHealthSchema, { onExcessProperty: "error" })(
        await response.json(),
      );
      if (Result.isFailure(result)) return false;
      return result.success.pid === expectedPid;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  public runForeground(options: DaemonOptions): ApplicationEffect<ProcessResult> {
    return fromPromise(() => this.startForeground(options).then((handle) => handle.wait()));
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

  public spawn(options: DaemonOptions): ApplicationEffect<DaemonProcessHandle> {
    return fromPromise(async () => {
      const handle = await spawnMuximod(this.launchOptions(options), {
        detached: true,
        stdio: "ignore",
        environment: this.options.environment,
      });
      let terminated = false;
      return {
        pid: handle.pid,
        wait: () => fromPromise(() => handle.wait()),
        terminate: () =>
          fromPromise(() => {
            if (terminated) return;
            terminated = true;
            handle.terminate();
          }),
      };
    });
  }

  public isHealthy(options: DaemonOptions, expectedPid?: number): ApplicationEffect<boolean> {
    return this.checkHealthy(options, expectedPid);
  }

  private checkHealthy(options: DaemonOptions, expectedPid?: number): ApplicationEffect<boolean> {
    const self = this;
    return Effect.gen(function* () {
      const requestedLaunchOptions = self.launchOptions(options);
      const record = yield* fromPromise(() => readMuximodPidRecord(requestedLaunchOptions.config.pidFile));
      if (record && expectedPid !== undefined && record.pid !== expectedPid) {
        const configurationFingerprint = muximodConfigurationFingerprint(requestedLaunchOptions);
        return yield* self.probeHealthy(
          options.host,
          options.port,
          expectedPid,
          configurationFingerprint,
          healthProbeTimeoutMs,
        );
      }

      const effectiveOptions = record ? { ...options, host: record.host, port: record.port } : options;
      const launchOptions = record ? self.launchOptions(effectiveOptions) : requestedLaunchOptions;
      const configurationFingerprint = muximodConfigurationFingerprint(launchOptions);
      return yield* self.probeHealthy(
        effectiveOptions.host,
        effectiveOptions.port,
        record?.pid ?? expectedPid,
        configurationFingerprint,
        healthProbeTimeoutMs,
      );
    });
  }

  private probeHealthy(
    host: string,
    port: number,
    expectedPid: number | undefined,
    configurationFingerprint: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): ApplicationEffect<boolean> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const controller = new AbortController();
        const abortProbe = () => controller.abort();
        signal?.addEventListener("abort", abortProbe, { once: true });
        const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
        return { controller, timeout, abortProbe };
      }),
      ({ controller }) =>
        Effect.gen(function* () {
          if (signal?.aborted) return false;
          const response = yield* fromPromise(() =>
            fetch(`http://${displayHost(host)}:${port}/health`, { signal: controller.signal }),
          );
          if (!response.ok) return false;
          const body = yield* fromPromise(() => response.json());
          const result = Schema.decodeUnknownResult(muximodHealthSchema, { onExcessProperty: "error" })(body);
          if (Result.isFailure(result)) return false;
          return (
            result.success.configurationFingerprint === configurationFingerprint &&
            (expectedPid === undefined || result.success.pid === expectedPid)
          );
        }).pipe(Effect.catch(() => Effect.succeed(false))),
      ({ timeout, abortProbe }) =>
        Effect.sync(() => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", abortProbe);
        }),
    );
  }

  private waitForHealthy(
    options: DaemonOptions,
    expectedPid?: number,
    signal?: AbortSignal,
  ): ApplicationEffect<boolean> {
    const self = this;
    return Effect.gen(function* () {
      const launchOptions = self.launchOptions(options);
      const configurationFingerprint = muximodConfigurationFingerprint(launchOptions);
      const deadline = systemClock.now() + lifecycleTimeoutMs;
      while (true) {
        if (signal?.aborted) return false;
        const remainingMs = deadline - systemClock.now();
        if (remainingMs <= 0) return false;
        if (
          yield* self.probeHealthy(
            options.host,
            options.port,
            expectedPid,
            configurationFingerprint,
            Math.min(healthProbeTimeoutMs, remainingMs),
            signal,
          )
        )
          return true;
        if (signal?.aborted) return false;
        const sleepMs = Math.min(bootstrapPollIntervalMs, deadline - systemClock.now());
        if (sleepMs <= 0) return false;
        yield* systemScheduler.sleep(sleepMs);
      }
    });
  }

  public isAlive(pid: number): ApplicationEffect<boolean> {
    return fromPromise(() => isProcessAlive(pid));
  }

  public signal(pid: number, signal: "SIGTERM"): ApplicationEffect<void> {
    return fromPromise(() => {
      process.kill(pid, signal);
    });
  }

  public readPidRecord(path: string): ApplicationEffect<DaemonPidRecord | undefined> {
    return fromPromise(() => readMuximodPidRecord(path));
  }

  public writePidRecord(path: string, record: DaemonPidRecord): ApplicationEffect<void> {
    return fromPromise(() => {
      writeMuximodPidRecord(path, record);
    });
  }

  public removePidRecord(path: string, expectedPid: number): ApplicationEffect<void> {
    return fromPromise(() => {
      removeMuximodPidRecord(path, expectedPid);
    });
  }

  public writeRestartMarker(pidFile: string, refreshServers: boolean): ApplicationEffect<void> {
    return fromPromise(() => {
      writeMuximodRestartMarker(pidFile, refreshServers);
    });
  }

  public hasRestartMarker(pidFile: string): ApplicationEffect<boolean> {
    return fromPromise(() => hasMuximodRestartMarker(pidFile));
  }

  public consumeRestartMarker(pidFile: string): ApplicationEffect<boolean | undefined> {
    return fromPromise(() => consumeMuximodRestartMarker(pidFile));
  }

  public removeRestartMarker(pidFile: string): ApplicationEffect<void> {
    return fromPromise(() => {
      removeMuximodRestartMarker(pidFile);
    });
  }

  private launchOptions(options: DaemonOptions): MuximodLaunchOptions {
    const config = normalizeMuximodConfig(decodeMuximodConfig(this.options.resolveConfig(options)));
    return { schemaMode: this.options.schemaMode, config };
  }
}

export class MuximodStartupError extends Error {
  public readonly result?: MuximodProcessResult;

  public constructor(result?: MuximodProcessResult) {
    super("muximod failed to start; see the daemon log for details");
    this.name = "MuximodStartupError";
    this.result = result;
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
  sleep: (milliseconds: number) =>
    fromPromise(() => new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds))),
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

function waitForProcessExit(pid: number, timeoutMs: number): ApplicationEffect<boolean> {
  return Effect.gen(function* () {
    const deadline = systemClock.now() + timeoutMs;
    while (isProcessAlive(pid)) {
      const remainingMs = deadline - systemClock.now();
      if (remainingMs <= 0) return false;
      yield* systemScheduler.sleep(Math.min(bootstrapPollIntervalMs, remainingMs));
    }
    return true;
  });
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
