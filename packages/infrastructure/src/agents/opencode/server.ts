/**
 * Owns the OpenCode V1 server sidecars started by Muximo.
 *
 * One server is started lazily per project root (the resolved workspace or
 * worktree directory the server is launched in) and reused by every OpenCode
 * session in that project. Ownership metadata is persisted so a later
 * `muximo run opencode` can reuse or restart the server.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { currentProcessStartedAt, observeProcessLiveness, type ProcessLiveness } from "../../process/process.js";
import { type OpenCodeLog, type OpenCodeRequest, openCodeRequestTimeoutMs, requestWithTimeout } from "./client.js";

export type OpenCodeServerEntry = {
  workspaceRoot: string;
  pid: number;
  port: number;
  version: string;
  startedAt: string;
};

export type OpenCodeServerRegistry = Record<string, OpenCodeServerEntry>;

type RegistryLockRecord = {
  pid: number;
  token?: string;
  startedAt?: string;
};

export type SpawnedChild = {
  pid: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

export type ProcessSignaller = {
  observe(pid: number, expectedStartedAt?: string): ProcessLiveness;
  kill(pid: number, signal: NodeJS.Signals, expectedStartedAt?: string): void;
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

export type OpenCodeProcessDisposalErrorCode = "opencode_process_disposal_failed" | "opencode_process_disposal_timeout";

export class OpenCodeServerDisposalError extends Error {
  public constructor(
    message: string,
    public readonly code: OpenCodeProcessDisposalErrorCode,
    public readonly pid: number,
    public readonly signal: NodeJS.Signals | undefined,
    public readonly retryable: boolean,
    cause?: unknown,
  ) {
    super(message);
    this.name = "OpenCodeServerDisposalError";
    if (cause !== undefined) Object.defineProperty(this, "cause", { configurable: true, value: cause });
  }
}

export type OpenCodeServerManagerOptions = {
  registryFile: string;
  environment?: NodeJS.ProcessEnv;
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
  shutdownTimeoutMs?: number;
  shutdownGracePeriodMs?: number;
  shutdownPollIntervalMs?: number;
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
export const openCodeServerShutdownTimeoutMs = 3_000;
export const openCodeServerShutdownGracePeriodMs = 2_000;
export const openCodeServerShutdownPollMs = 50;
// Registry mutations include starting or stopping a server. Leave enough time
// for the bounded server lifecycle to finish before reporting contention.
export const openCodeRegistryLockTimeoutMs = 30_000;
export const openCodeRegistryLockPollMs = 50;

export function defaultOpenCodeRegistryFile(env: NodeJS.ProcessEnv = process.env): string {
  const instanceDirectory = env.MUXIMOD_INSTANCE_DIR?.trim()
    ? env.MUXIMOD_INSTANCE_DIR.trim()
    : join(env.HOME ?? homedir(), ".local", "state", "muximo");
  return join(instanceDirectory, "opencode-servers.json");
}

export class OpenCodeServerManager {
  private readonly executable: string;
  private readonly spawn: OpenCodeServerManagerOptions["spawn"];
  private readonly request: OpenCodeRequest;
  private readonly allocatePort: () => Promise<number>;
  private readonly probePort: (port: number) => Promise<boolean>;
  private readonly healthPollIntervalMs: number;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly shutdownGracePeriodMs: number;
  private readonly shutdownPollIntervalMs: number;
  private readonly registryLockTimeoutMs: number;
  private readonly registryLockPollIntervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logFileDirectory: string;
  private readonly signaller: ProcessSignaller;
  private readonly onLog: OpenCodeLog | undefined;
  private readonly processStartedAt: string | undefined;
  private readonly children = new Set<SpawnedChild>();

  public constructor(private readonly options: OpenCodeServerManagerOptions) {
    this.executable = options.executable ?? options.environment?.MUXIMO_OPENCODE_BIN ?? "opencode";
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawnServe(command, args, spawnOptions));
    this.request = options.request ?? ((url, init) => fetch(url, init));
    this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this.probePort = options.probePort ?? probeLoopbackPort;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? openCodeServerHealthPollMs;
    this.startupTimeoutMs = options.startupTimeoutMs ?? openCodeServerDefaultTimeoutMs;
    this.shutdownTimeoutMs = Math.max(0, options.shutdownTimeoutMs ?? openCodeServerShutdownTimeoutMs);
    this.shutdownGracePeriodMs = Math.max(0, options.shutdownGracePeriodMs ?? openCodeServerShutdownGracePeriodMs);
    this.shutdownPollIntervalMs = Math.max(1, options.shutdownPollIntervalMs ?? openCodeServerShutdownPollMs);
    this.registryLockTimeoutMs = Math.max(0, options.registryLockTimeoutMs ?? openCodeRegistryLockTimeoutMs);
    this.registryLockPollIntervalMs = Math.max(1, options.registryLockPollIntervalMs ?? openCodeRegistryLockPollMs);
    this.requestTimeoutMs = Math.max(0, options.requestTimeoutMs ?? openCodeRequestTimeoutMs);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.logFileDirectory = options.logFileDirectory ?? dirnameOf(options.registryFile);
    this.signaller = options.signaller ?? defaultSignaller;
    this.onLog = options.onLog;
    this.processStartedAt = currentProcessStartedAt();
  }

  /**
   * Return the owned server for a project root, starting or restarting it as
   * needed. A replacement server prefers the port previously recorded for the
   * root so clients holding the server URL keep working. Never stops a server
   * whose pid is not owned by this registry.
   */
  public async ensure(workspaceRoot: string, signal?: AbortSignal): Promise<OpenCodeServerEntry> {
    return this.withFileLock(async () => {
      const registry = this.readRegistry();
      const existing = registry[workspaceRoot];
      if (existing) {
        const existingLiveness = this.observe(existing.pid, existing.startedAt);
        if (existingLiveness === "unknown") throw unknownProcessIdentity(existing.pid);
        if (existingLiveness === "alive" && (await this.isHealthy(existing.port, signal))) {
          return existing;
        }
        throwIfAborted(signal);
        await this.disposeEntry(existing);
        delete registry[workspaceRoot];
      }

      throwIfAborted(signal);
      const port = existing ? await this.allocatePreferredPort(existing.port) : await this.allocatePort();
      throwIfAborted(signal);
      const child = this.spawnServer(workspaceRoot, port);
      let health: { healthy: boolean; version: string } | undefined;
      try {
        health = await this.waitForHealth(port, child.pid, signal);
      } catch (error) {
        try {
          await this.disposeChild(child);
        } catch (cleanupError) {
          this.onLog?.("warn", "opencode.server_cleanup_failed", {
            pid: child.pid,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          });
          throw cleanupError;
        }
        throw error;
      }
      const entry: OpenCodeServerEntry = {
        workspaceRoot,
        pid: child.pid,
        port,
        version: health.version,
        startedAt: new Date(this.now()).toISOString(),
      };
      registry[workspaceRoot] = entry;
      this.writeRegistry(registry);
      return entry;
    }, signal);
  }

  /**
   * Restart every owned server on the port it already uses, so configuration
   * and environment changes made outside Muximo are picked up while the
   * server URLs stay stable. A root whose server cannot be restarted is dropped
   * from the registry.
   */
  public async refreshAll(): Promise<void> {
    await this.withFileLock(async () => {
      const registry = this.readRegistry();
      for (const [workspaceRoot, entry] of Object.entries(registry)) {
        const refreshed = await this.restartOnPort(workspaceRoot, entry);
        if (refreshed) registry[workspaceRoot] = refreshed;
        else delete registry[workspaceRoot];
      }
      this.writeRegistry(registry);
    });
  }

  public async isHealthy(port: number, signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await requestWithTimeout(
        this.request,
        `http://127.0.0.1:${port}/global/health`,
        signal === undefined ? undefined : { signal },
        this.requestTimeoutMs,
      );
      if (!response.ok) return false;
      const body: unknown = await response.json().catch(() => undefined);
      return Boolean(body && typeof body === "object" && (body as { healthy?: unknown }).healthy === true);
    } catch {
      return false;
    }
  }

  public async dispose(workspaceRoot: string): Promise<boolean> {
    return this.withFileLock(async () => {
      const registry = this.readRegistry();
      const entry = registry[workspaceRoot];
      if (!entry) return false;
      await this.disposeEntry(entry);
      delete registry[workspaceRoot];
      this.writeRegistry(registry);
      return true;
    });
  }

  public async disposeAll(): Promise<void> {
    await this.withFileLock(async () => {
      const registry = this.readRegistry();
      const failures: unknown[] = [];
      const remaining: OpenCodeServerRegistry = {};
      for (const [workspaceRoot, entry] of Object.entries(registry)) {
        try {
          await this.disposeEntry(entry);
        } catch (error) {
          remaining[workspaceRoot] = entry;
          failures.push(error);
        }
      }
      this.writeRegistry(remaining);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "OpenCode server disposal failed for multiple registered processes");
      }
    });
  }

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
    this.onLog?.("debug", "opencode.server_started", { pid: child.pid, port, workspaceRoot });
    child.unref?.();
    this.children.add(child);
    child.on("exit", () => {
      this.children.delete(child);
    });
    return child;
  }

  private async waitForHealth(
    port: number,
    pid: number,
    signal?: AbortSignal,
  ): Promise<{ healthy: boolean; version: string }> {
    const deadline = this.now() + this.startupTimeoutMs;
    for (;;) {
      throwIfAborted(signal);
      if (this.observe(pid) === "dead") {
        throw new Error(`opencode serve exited before it became healthy (${this.executable} serve --port ${port})`);
      }
      const health = await this.isHealthy(port, signal);
      if (health) return { healthy: true, version: await this.readVersion(port, signal) };
      if (this.now() >= deadline) {
        throw new Error(
          `opencode serve did not become healthy within ${this.startupTimeoutMs}ms (${this.executable} serve --port ${port})`,
        );
      }
      await sleepWithAbort(this.sleep, this.healthPollIntervalMs, signal);
    }
  }

  private async readVersion(port: number, signal?: AbortSignal): Promise<string> {
    const response = await requestWithTimeout(
      this.request,
      `http://127.0.0.1:${port}/global/health`,
      signal === undefined ? undefined : { signal },
      this.requestTimeoutMs,
    );
    if (!response.ok) throw new Error(`OpenCode health endpoint returned ${response.status} while reading its version`);
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new Error("OpenCode health endpoint returned invalid JSON while reading its version", { cause: error });
    }
    if (!isRecord(body) || typeof body.version !== "string" || body.version.length === 0) {
      throw new Error("OpenCode health endpoint returned an invalid version");
    }
    return body.version;
  }

  private async disposeEntry(entry: OpenCodeServerEntry): Promise<void> {
    this.onLog?.("debug", "opencode.server_disposing", { pid: entry.pid, port: entry.port });
    await this.signalAndWaitExit(
      entry.pid,
      (signal) => this.signaller.kill(entry.pid, signal, entry.startedAt),
      entry.startedAt,
    );
  }

  /**
   * Stop one registered server and start a replacement on the same port. Waits
   * for the old process to release the port; falls back to a fresh port when
   * the recorded one is taken by another process. Returns undefined when the
   * replacement never becomes healthy.
   */
  private async restartOnPort(
    workspaceRoot: string,
    entry: OpenCodeServerEntry,
  ): Promise<OpenCodeServerEntry | undefined> {
    this.onLog?.("debug", "opencode.server_refreshing", { workspaceRoot, pid: entry.pid, port: entry.port });
    await this.signalAndWaitExit(
      entry.pid,
      (signal) => this.signaller.kill(entry.pid, signal, entry.startedAt),
      entry.startedAt,
    );
    const port = await this.allocatePreferredPort(entry.port);
    const child = this.spawnServer(workspaceRoot, port);
    try {
      const health = await this.waitForHealth(port, child.pid);
      return {
        workspaceRoot,
        pid: child.pid,
        port,
        version: health.version,
        startedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      try {
        await this.disposeChild(child);
      } catch (cleanupError) {
        this.onLog?.("warn", "opencode.server_cleanup_failed", {
          workspaceRoot,
          pid: child.pid,
          error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        });
        throw cleanupError;
      }
      this.onLog?.("warn", "opencode.server_refresh_failed", {
        workspaceRoot,
        port,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async signalAndWaitExit(
    pid: number,
    sendSignal: (signal: NodeJS.Signals) => void,
    expectedStartedAt?: string,
  ): Promise<void> {
    const initialLiveness = this.observe(pid, expectedStartedAt);
    if (initialLiveness === "dead") {
      this.forgetChildrenForPid(pid);
      return;
    }
    if (initialLiveness === "unknown") throw unknownProcessIdentity(pid);

    let signal: NodeJS.Signals = "SIGTERM";
    try {
      sendSignal(signal);
    } catch (error) {
      const liveness = this.observe(pid, expectedStartedAt);
      if (liveness === "dead") {
        this.forgetChildrenForPid(pid);
        return;
      }
      if (liveness === "unknown") throw unknownProcessIdentity(pid, signal);
      this.onLog?.("warn", "opencode.server_not_owned", { pid });
      throw new OpenCodeServerDisposalError(
        `OpenCode process ${pid} could not be terminated; the resource may still be running`,
        "opencode_process_disposal_failed",
        pid,
        signal,
        false,
        error,
      );
    }

    const startedAt = this.now();
    const deadline = startedAt + this.shutdownTimeoutMs;
    const forceAt = startedAt + Math.min(this.shutdownGracePeriodMs, this.shutdownTimeoutMs);
    let forceSent = false;
    for (;;) {
      const liveness = this.observe(pid, expectedStartedAt);
      if (liveness === "dead") {
        this.forgetChildrenForPid(pid);
        return;
      }
      if (liveness === "unknown") throw unknownProcessIdentity(pid, signal);
      const now = this.now();
      if (!forceSent && now >= forceAt) {
        signal = "SIGKILL";
        try {
          sendSignal(signal);
        } catch (error) {
          const liveness = this.observe(pid, expectedStartedAt);
          if (liveness === "alive") {
            throw new OpenCodeServerDisposalError(
              `OpenCode process ${pid} could not be force-terminated; the resource may still be running`,
              "opencode_process_disposal_failed",
              pid,
              signal,
              false,
              error,
            );
          }
          if (liveness === "unknown") throw unknownProcessIdentity(pid, signal);
        }
        forceSent = true;
        const liveness = this.observe(pid, expectedStartedAt);
        if (liveness === "dead") {
          this.forgetChildrenForPid(pid);
          return;
        }
        if (liveness === "unknown") throw unknownProcessIdentity(pid, signal);
      }
      if (this.now() >= deadline) {
        throw new OpenCodeServerDisposalError(
          `OpenCode process ${pid} did not exit within ${this.shutdownTimeoutMs}ms after termination; retry cleanup`,
          "opencode_process_disposal_timeout",
          pid,
          signal,
          true,
        );
      }
      await this.sleep(Math.min(this.shutdownPollIntervalMs, Math.max(1, deadline - this.now())));
    }
  }

  private async allocatePreferredPort(preferred: number): Promise<number> {
    if (await this.probePort(preferred)) return preferred;
    return this.allocatePort();
  }

  private async disposeChild(child: SpawnedChild): Promise<void> {
    await this.signalAndWaitExit(child.pid, (signal) => {
      if (!child.kill(signal) && this.observe(child.pid) === "alive") {
        throw new Error(`child process ${child.pid} rejected ${signal}`);
      }
    });
    this.children.delete(child);
  }

  private forgetChildrenForPid(pid: number): void {
    for (const child of this.children) {
      if (child.pid === pid) this.children.delete(child);
    }
  }

  private observe(pid: number, expectedStartedAt?: string): ProcessLiveness {
    return this.signaller.observe(pid, expectedStartedAt);
  }

  /**
   * Serialize registry mutations across `muximo run` processes in the same
   * instance so two panes starting concurrently share one server. Stale locks
   * (dead owner) are broken; a lock that stays contended returns a retryable
   * error and never runs the mutation without ownership.
   */
  private async withFileLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const lockPath = `${this.options.registryFile}.lock`;
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
    kill: (signal) => child.kill(signal),
    unref: () => child.unref(),
    on: (event, listener) => {
      child.on(event, listener);
    },
  };
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
  if (keys.join(",") !== ["pid", "port", "startedAt", "version", "workspaceRoot"].join(",")) return false;
  return (
    value.workspaceRoot === workspaceRoot &&
    isPositiveInteger(value.pid) &&
    isPort(value.port) &&
    typeof value.version === "string" &&
    value.version.length > 0 &&
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

const defaultSignaller: ProcessSignaller = {
  observe(pid: number, expectedStartedAt?: string): ProcessLiveness {
    return observeProcessLiveness(pid, expectedStartedAt);
  },
  kill(pid: number, signal: NodeJS.Signals, expectedStartedAt?: string): void {
    if (expectedStartedAt !== undefined && observeProcessLiveness(pid, expectedStartedAt) !== "alive") return;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
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

function unknownProcessIdentity(pid: number, signal?: NodeJS.Signals): OpenCodeServerDisposalError {
  return new OpenCodeServerDisposalError(
    `OpenCode process ${pid} could not be verified; refusing to terminate or release its registry entry`,
    "opencode_process_disposal_failed",
    pid,
    signal,
    true,
  );
}
