/**
 * Discovers and bootstraps OpenCode V1 server connections.
 *
 * One connection is recorded per project root (the resolved workspace or
 * worktree directory the server is serving). The registry is shared by all
 * Muximo environments in one state root, so a daemon restart or a different
 * daemon can reuse the same server. Muximo never treats a server reference as
 * a process ownership lease and never sends a termination signal to it.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer as createNetServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentProcessStartedAt, observeProcessLiveness, type ProcessLiveness } from "../../process/process.js";
import { type OpenCodeLog, type OpenCodeRequest, openCodeRequestTimeoutMs, requestWithTimeout } from "./client.js";

export type OpenCodeServerEntry = {
  workspaceRoot: string;
  /** Present only when the connection was bootstrapped by a Muximo process. */
  pid?: number;
  port: number;
  version: string;
  /** Present only with the optional bootstrap PID identity. */
  startedAt?: string;
};

export type OpenCodeServerRegistry = Record<string, OpenCodeServerEntry>;

type RegistryLockRecord = {
  pid: number;
  token?: string;
  startedAt?: string;
};

export type SpawnedChild = {
  pid: number;
  unref(): void;
};

export type ProcessSignaller = {
  observe(pid: number, expectedStartedAt?: string): ProcessLiveness;
};

export class OpenCodeRegistryLockTimeoutError extends Error {
  public readonly code = "opencode_registry_lock_timeout" as const;
  public readonly retryable = true;

  public constructor(
    public readonly lockPath: string,
    public readonly timeoutMs: number,
  ) {
    super(`OpenCode server registry lock could not be acquired within ${timeoutMs}ms; retry the operation`);
    this.name = "OpenCodeRegistryLockTimeoutError";
  }
}

export class OpenCodeServerUnavailableError extends Error {
  public readonly code = "opencode_server_unavailable" as const;
  public readonly retryable = true;

  public constructor(
    public readonly workspaceRoot: string,
    public readonly port: number,
    cause?: unknown,
  ) {
    super(`OpenCode server for ${workspaceRoot} is unavailable on port ${port}`, { cause });
    this.name = "OpenCodeServerUnavailableError";
  }
}

export type OpenCodeServerManagerOptions = {
  registryFile: string;
  environment?: NodeJS.ProcessEnv;
  /** Connect to this local server instead of bootstrapping one. */
  serverUrl?: string;
  executable?: string;
  spawn?: (
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; logFile: string },
  ) => SpawnedChild;
  request?: OpenCodeRequest;
  allocatePort?: () => Promise<number>;
  probePort?: (port: number) => Promise<boolean>;
  healthPollIntervalMs?: number;
  startupTimeoutMs?: number;
  registryLockTimeoutMs?: number;
  registryLockPollIntervalMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  logFileDirectory?: string;
  signaller?: ProcessSignaller;
  onLog?: OpenCodeLog;
};

export const openCodeServerDefaultTimeoutMs = 15_000;
export const openCodeServerHealthPollMs = 100;
// Registry mutations include starting a server. Leave enough time for the
// bounded startup lifecycle to finish before reporting contention.
export const openCodeRegistryLockTimeoutMs = 30_000;
export const openCodeRegistryLockPollMs = 50;

export function defaultOpenCodeRegistryFile(): string {
  return join(tmpdir(), "muximo", "opencode-servers.json");
}

type OpenCodeHealth = {
  healthy: true;
  version: string;
};

type ParsedServerUrl = {
  baseUrl: string;
  port: number;
};

export class OpenCodeServerManager {
  private readonly executable: string;
  private readonly spawn: OpenCodeServerManagerOptions["spawn"];
  private readonly request: OpenCodeRequest;
  private readonly allocatePort: () => Promise<number>;
  private readonly probePort: (port: number) => Promise<boolean>;
  private readonly healthPollIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private readonly registryLockTimeoutMs: number;
  private readonly registryLockPollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logFileDirectory: string;
  private readonly signaller: ProcessSignaller;
  private readonly onLog: OpenCodeLog | undefined;
  private readonly processStartedAt: string | undefined;
  private readonly configuredServer: ParsedServerUrl | undefined;

  public constructor(private readonly options: OpenCodeServerManagerOptions) {
    this.executable = options.executable ?? "opencode";
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawnServe(command, args, spawnOptions));
    this.request = options.request ?? ((url, init) => fetch(url, init));
    this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this.probePort = options.probePort ?? probeLoopbackPort;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? openCodeServerHealthPollMs;
    this.startupTimeoutMs = options.startupTimeoutMs ?? openCodeServerDefaultTimeoutMs;
    this.registryLockTimeoutMs = Math.max(0, options.registryLockTimeoutMs ?? openCodeRegistryLockTimeoutMs);
    this.registryLockPollIntervalMs = Math.max(1, options.registryLockPollIntervalMs ?? openCodeRegistryLockPollMs);
    this.requestTimeoutMs = Math.max(0, options.requestTimeoutMs ?? openCodeRequestTimeoutMs);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.logFileDirectory = options.logFileDirectory ?? dirnameOf(options.registryFile);
    this.signaller = options.signaller ?? defaultSignaller;
    this.onLog = options.onLog;
    this.processStartedAt = currentProcessStartedAt();
    const configuredServerUrl = options.serverUrl;
    this.configuredServer =
      configuredServerUrl === undefined || configuredServerUrl.trim().length === 0
        ? undefined
        : parseConfiguredServerUrl(configuredServerUrl);
  }

  /**
   * Return a healthy connection for a project root. Existing healthy
   * connections are reused; dead references are replaced without signalling
   * their old processes. When no external URL is configured, Muximo starts a
   * detached OpenCode server as a bootstrap operation and leaves it running
   * after this manager exits.
   */
  public async ensure(workspaceRoot: string, signal?: AbortSignal): Promise<OpenCodeServerEntry> {
    if (this.configuredServer !== undefined) {
      throwIfAborted(signal);
      const health = await this.readHealth(this.configuredServer.baseUrl, workspaceRoot, signal);
      throwIfAborted(signal);
      if (health === undefined) {
        throw new OpenCodeServerUnavailableError(workspaceRoot, this.configuredServer.port);
      }
      return {
        workspaceRoot,
        port: this.configuredServer.port,
        version: health.version,
      };
    }

    return this.withFileLock(async () => {
      const registry = this.readRegistry();

      const existing = registry[workspaceRoot];
      if (existing !== undefined) {
        try {
          const health = await this.waitForHealth(
            existing.port,
            workspaceRoot,
            existing.pid,
            existing.startedAt,
            signal,
          );
          const refreshed =
            existing.pid !== undefined && this.observe(existing.pid, existing.startedAt) === "dead"
              ? removeProcessIdentity(existing)
              : { ...existing, version: health.version };
          if (refreshed.version !== existing.version || refreshed.pid !== existing.pid) {
            registry[workspaceRoot] = refreshed;
            this.writeRegistry(registry);
          }
          return refreshed;
        } catch (error) {
          throwIfAborted(signal);
          const liveness = existing.pid === undefined ? undefined : this.observe(existing.pid, existing.startedAt);
          const portAvailable = liveness === "dead" ? true : await this.probePort(existing.port);
          if (liveness === "alive" || liveness === "unknown" || !portAvailable) {
            throw new OpenCodeServerUnavailableError(workspaceRoot, existing.port, error);
          }
          delete registry[workspaceRoot];
        }
      }

      throwIfAborted(signal);
      const port = existing === undefined ? await this.allocatePort() : await this.allocatePreferredPort(existing.port);
      throwIfAborted(signal);
      const child = this.spawnServer(workspaceRoot, port);
      const startingEntry: OpenCodeServerEntry = {
        workspaceRoot,
        pid: child.pid,
        port,
        version: "starting",
        startedAt: new Date(this.now()).toISOString(),
      };
      // Record the reference before waiting so a timeout does not turn a
      // detached bootstrap process into an unreferenced duplicate on retry.
      registry[workspaceRoot] = startingEntry;
      this.writeRegistry(registry);

      try {
        const health = await this.waitForHealth(port, workspaceRoot, child.pid, startingEntry.startedAt, signal);
        const entry: OpenCodeServerEntry = { ...startingEntry, version: health.version };
        registry[workspaceRoot] = entry;
        this.writeRegistry(registry);
        return entry;
      } catch (error) {
        this.onLog?.("warn", "opencode.server_startup_incomplete", {
          pid: child.pid,
          port,
          workspaceRoot,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    }, signal);
  }

  /** Returns all connection references without probing or mutating them. */
  public list(): OpenCodeServerEntry[] {
    return Object.values(this.readRegistry());
  }

  private readRegistry(): OpenCodeServerRegistry {
    let contents: string;
    try {
      contents = readFileSync(this.options.registryFile, "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) return {};
      throw new Error(`OpenCode server registry could not be read: ${this.options.registryFile}`, { cause: error });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`OpenCode server registry contains invalid JSON: ${this.options.registryFile}`, { cause: error });
    }
    if (!isRecord(parsed)) {
      throw new Error(`OpenCode server registry must be an object: ${this.options.registryFile}`);
    }

    const registry: OpenCodeServerRegistry = {};
    for (const [root, entry] of Object.entries(parsed)) {
      if (!isOpenCodeServerEntry(entry, root)) {
        throw new Error(`OpenCode server registry entry is invalid: ${root}`);
      }
      registry[root] = entry;
    }
    return registry;
  }

  private writeRegistry(registry: OpenCodeServerRegistry): void {
    const directory = dirnameOf(this.options.registryFile);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.options.registryFile}.tmp`;
    writeFileSync(temporary, JSON.stringify(registry, null, 2), { mode: 0o600 });
    renameSync(temporary, this.options.registryFile);
  }

  private spawnServer(workspaceRoot: string, port: number): SpawnedChild {
    const logFile = join(this.logFileDirectory, `opencode-${hashPath(workspaceRoot)}.log`);
    const spawn = this.spawn;
    if (!spawn) throw new Error("opencode server cannot start without a spawn function");
    const child = spawn(this.executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: workspaceRoot,
      env: this.options.environment ?? process.env,
      detached: true,
      logFile,
    });
    this.onLog?.("debug", "opencode.server_bootstrapped", { pid: child.pid, port, workspaceRoot });
    child.unref();
    return child;
  }

  private async waitForHealth(
    port: number,
    workspaceRoot: string,
    pid: number | undefined,
    expectedStartedAt: string | undefined,
    signal?: AbortSignal,
  ): Promise<OpenCodeHealth> {
    const deadline = this.now() + this.startupTimeoutMs;
    for (;;) {
      throwIfAborted(signal);
      const health = await this.readHealth(baseUrlForPort(port), workspaceRoot, signal);
      if (health !== undefined) return health;
      if (pid !== undefined && this.observe(pid, expectedStartedAt) === "dead") {
        throw new Error(`opencode serve exited before it became healthy (${this.executable} serve --port ${port})`);
      }
      if (this.now() >= deadline) {
        throw new Error(
          `opencode serve did not become healthy within ${this.startupTimeoutMs}ms (${this.executable} serve --port ${port})`,
        );
      }
      await sleepWithAbort(this.sleep, this.healthPollIntervalMs, signal);
    }
  }

  private async readHealth(
    baseUrl: string,
    workspaceRoot: string,
    signal?: AbortSignal,
  ): Promise<OpenCodeHealth | undefined> {
    try {
      const response = await requestWithTimeout(
        this.request,
        `${baseUrl}/global/health`,
        {
          headers: { "x-opencode-directory": workspaceRoot },
          ...(signal === undefined ? {} : { signal }),
        },
        this.requestTimeoutMs,
      );
      if (!response.ok) return undefined;
      const body: unknown = await response.json().catch(() => undefined);
      if (!isRecord(body) || body.healthy !== true) return undefined;
      if (typeof body.version !== "string" || body.version.length === 0) {
        throw new Error("OpenCode health endpoint returned an invalid version");
      }
      return { healthy: true, version: body.version };
    } catch {
      return undefined;
    }
  }

  private async allocatePreferredPort(preferred: number): Promise<number> {
    if (await this.probePort(preferred)) return preferred;
    return this.allocatePort();
  }

  private observe(pid: number, expectedStartedAt?: string): ProcessLiveness {
    return this.signaller.observe(pid, expectedStartedAt);
  }

  /**
   * Serialize registry mutations across `muximo run` processes. The lock is a
   * coordination barrier for the registry only; it grants no process control.
   */
  private async withFileLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lockPath = `${this.options.registryFile}.lock`;
    mkdirSync(dirnameOf(lockPath), { recursive: true, mode: 0o700 });
    const deadline = this.now() + this.registryLockTimeoutMs;
    for (;;) {
      throwIfAborted(signal);
      const token = this.tryAcquireLock(lockPath);
      if (token === undefined) {
        this.tryReclaimStaleLock(lockPath);
        throwIfAborted(signal);
        if (this.now() >= deadline) {
          this.onLog?.("warn", "opencode.registry_lock_timeout", { path: lockPath });
          throw new OpenCodeRegistryLockTimeoutError(lockPath, this.registryLockTimeoutMs);
        }
        await sleepWithAbort(
          this.sleep,
          Math.min(this.registryLockPollIntervalMs, Math.max(1, deadline - this.now())),
          signal,
        );
        continue;
      }
      try {
        throwIfAborted(signal);
        return await operation();
      } finally {
        this.releaseLock(lockPath, token);
      }
    }
  }

  private tryAcquireLock(lockPath: string): string | undefined {
    if (existsSync(reclaimPath(lockPath))) return undefined;
    const token = randomUUID();
    let fd: number | undefined;
    let created = false;
    try {
      fd = openSync(lockPath, "wx", 0o600);
      created = true;
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          token,
          ...(this.processStartedAt === undefined ? {} : { startedAt: this.processStartedAt }),
        }),
      );
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (created) {
        try {
          unlinkSync(lockPath);
        } catch {
          // Preserve the original write failure.
        }
      }
      if (isLockExistsError(error)) return undefined;
      throw error;
    }
    // A stale-lock reclaimer may have claimed the barrier after the initial
    // check. Never begin the mutation while that barrier is present.
    if (existsSync(reclaimPath(lockPath))) {
      this.releaseLock(lockPath, token);
      return undefined;
    }
    return token;
  }

  private tryReclaimStaleLock(lockPath: string): boolean {
    const reclaim = reclaimPath(lockPath);
    const token = randomUUID();
    let fd: number | undefined;
    try {
      fd = openSync(reclaim, "wx", 0o600);
      writeFileSync(
        fd,
        JSON.stringify({
          pid: process.pid,
          token,
          ...(this.processStartedAt === undefined ? {} : { startedAt: this.processStartedAt }),
        }),
      );
      closeSync(fd);
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if (!isLockExistsError(error)) throw error;
      const existingReclaim = readLockRecord(reclaim);
      if (existingReclaim && this.lockOwnerIsDead(existingReclaim)) {
        this.removeLockIfUnchanged(reclaim, existingReclaim);
      }
      return false;
    }

    try {
      const lock = readLockRecord(lockPath);
      if (!existsSync(lockPath)) return true;
      if (!lock || !this.lockOwnerIsDead(lock)) return false;
      return this.removeLockIfUnchanged(lockPath, lock);
    } finally {
      this.releaseLock(reclaim, token);
    }
  }

  private lockOwnerIsDead(record: RegistryLockRecord): boolean {
    if (record.pid === process.pid) return false;
    return this.observe(record.pid, record.startedAt) === "dead";
  }

  private releaseLock(lockPath: string, token: string): void {
    const record = readLockRecord(lockPath);
    if (!record || record.token !== token) return;
    try {
      unlinkSync(lockPath);
    } catch {
      // The lock may already have been removed.
    }
  }

  private removeLockIfUnchanged(lockPath: string, expected: RegistryLockRecord): boolean {
    const current = readLockRecord(lockPath);
    if (!current || !sameLockRecord(current, expected)) return false;
    try {
      unlinkSync(lockPath);
      return true;
    } catch {
      return false;
    }
  }
}

function spawnServe(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; detached: boolean; logFile: string },
): SpawnedChild {
  let logFd: number | undefined;
  try {
    mkdirSync(dirnameOf(options.logFile), { recursive: true, mode: 0o700 });
    logFd = openSync(options.logFile, "a", 0o600);
  } catch {
    // Logging is best effort; the server still runs.
  }
  const stdio: Array<"ignore" | number> =
    logFd === undefined ? ["ignore", "ignore", "ignore"] : ["ignore", logFd, logFd];
  const child = nodeSpawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached,
    stdio,
  });
  return {
    pid: child.pid ?? 0,
    unref: () => child.unref(),
  };
}

function parseConfiguredServerUrl(value: string): ParsedServerUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`MUXIMO_OPENCODE_SERVER_URL must be a valid URL: ${value}`, { cause: error });
  }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error("MUXIMO_OPENCODE_SERVER_URL must use an unauthenticated http://127.0.0.1 URL");
  }
  if (!url.port || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("MUXIMO_OPENCODE_SERVER_URL must include a port and must not include a path or query");
  }
  const port = Number.parseInt(url.port, 10);
  if (!isPort(port)) throw new Error(`MUXIMO_OPENCODE_SERVER_URL has an invalid port: ${value}`);
  return { baseUrl: `http://127.0.0.1:${port}`, port };
}

function baseUrlForPort(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function removeProcessIdentity(entry: OpenCodeServerEntry): OpenCodeServerEntry {
  const { pid: _pid, startedAt: _startedAt, ...reference } = entry;
  return reference;
}

function dirnameOf(path: string): string {
  const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separator === -1 ? "." : path.slice(0, separator);
}

function hashPath(path: string): string {
  let hash = 0;
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server: Server = createNetServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close(() => {
        if (typeof port !== "number") {
          reject(new Error("could not allocate a loopback port"));
          return;
        }
        resolvePromise(port);
      });
    });
  });
}

function probeLoopbackPort(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server: Server = createNetServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => {
      server.close(() => resolvePromise(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function isLockExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function reclaimPath(lockPath: string): string {
  return `${lockPath}.reclaim`;
}

function readLockRecord(path: string): RegistryLockRecord | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8").trim();
  } catch (error) {
    if (isFileNotFoundError(error)) return undefined;
    return undefined;
  }
  if (!contents) return undefined;
  const legacyPid = Number.parseInt(contents, 10);
  if (String(legacyPid) === contents && isPositiveInteger(legacyPid)) return { pid: legacyPid };
  try {
    const parsed: unknown = JSON.parse(contents);
    if (!isRecord(parsed) || !isPositiveInteger(parsed.pid)) return undefined;
    const token = typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : undefined;
    const startedAt =
      typeof parsed.startedAt === "string" && isIsoTimestamp(parsed.startedAt) ? parsed.startedAt : undefined;
    if (parsed.token !== undefined && token === undefined) return undefined;
    if (parsed.startedAt !== undefined && startedAt === undefined) return undefined;
    return {
      pid: parsed.pid,
      ...(token === undefined ? {} : { token }),
      ...(startedAt === undefined ? {} : { startedAt }),
    };
  } catch {
    return undefined;
  }
}

function sameLockRecord(left: RegistryLockRecord, right: RegistryLockRecord): boolean {
  return left.pid === right.pid && left.token === right.token && left.startedAt === right.startedAt;
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isOpenCodeServerEntry(value: unknown, workspaceRoot: string): value is OpenCodeServerEntry {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort();
  const allowed = ["pid", "port", "startedAt", "version", "workspaceRoot"];
  if (keys.some((key) => !allowed.includes(key))) return false;
  if (value.workspaceRoot !== workspaceRoot || !isPort(value.port)) return false;
  if (typeof value.version !== "string" || value.version.length === 0) return false;
  const hasPid = value.pid !== undefined;
  const hasStartedAt = value.startedAt !== undefined;
  if (hasPid !== hasStartedAt) return false;
  return (
    (!hasPid || isPositiveInteger(value.pid)) &&
    (!hasStartedAt || (typeof value.startedAt === "string" && isIsoTimestamp(value.startedAt)))
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

const defaultSignaller: ProcessSignaller = {
  observe(pid: number, expectedStartedAt?: string): ProcessLiveness {
    return observeProcessLiveness(pid, expectedStartedAt);
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("OpenCode server preparation was cancelled");
}

async function sleepWithAbort(
  wait: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    await wait(milliseconds);
    return;
  }
  throwIfAborted(signal);
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("operation aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([wait(milliseconds), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
