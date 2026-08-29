/**
 * Owns the OpenCode V1 server sidecars started by Muximo.
 *
 * One server is started lazily per project root (the resolved workspace or
 * worktree directory the server is launched in) and reused by every OpenCode
 * session in that project. Ownership metadata is persisted so a later
 * `muximo run opencode` can reuse or restart the server.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer, type Server } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OpenCodeLog, OpenCodeRequest } from "./client.js";

export type OpenCodeServerEntry = {
  workspaceRoot: string;
  pid: number;
  port: number;
  version: string;
  startedAt: string;
};

export type OpenCodeServerRegistry = Record<string, OpenCodeServerEntry>;

export type SpawnedChild = {
  pid: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  unref(): void;
  on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
};

export type ProcessSignaller = {
  isAlive(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
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
export const openCodeRegistryLockTimeoutMs = 5_000;
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
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly logFileDirectory: string;
  private readonly signaller: ProcessSignaller;
  private readonly onLog: OpenCodeLog | undefined;
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
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? sleep;
    this.logFileDirectory = options.logFileDirectory ?? dirnameOf(options.registryFile);
    this.signaller = options.signaller ?? defaultSignaller;
    this.onLog = options.onLog;
  }

  /**
   * Return the owned server for a project root, starting or restarting it as
   * needed. A replacement server prefers the port previously recorded for the
   * root so clients holding the server URL keep working. Never stops a server
   * whose pid is not owned by this registry.
   */
  public async ensure(workspaceRoot: string): Promise<OpenCodeServerEntry> {
    return this.withFileLock(async () => {
      const registry = this.readRegistry();
      const existing = registry[workspaceRoot];
      if (existing) {
        if (this.isAlive(existing.pid) && (await this.isHealthy(existing.port))) {
          return existing;
        }
        await this.disposeEntry(existing);
        delete registry[workspaceRoot];
      }

      const port = existing ? await this.allocatePreferredPort(existing.port) : await this.allocatePort();
      const child = this.spawnServer(workspaceRoot, port);
      let health: { healthy: boolean; version: string } | undefined;
      try {
        health = await this.waitForHealth(port, child.pid);
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
    });
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

  public async isHealthy(port: number): Promise<boolean> {
    try {
      const response = await this.request(`http://127.0.0.1:${port}/global/health`);
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

  private async waitForHealth(port: number, pid: number): Promise<{ healthy: boolean; version: string }> {
    const deadline = this.now() + this.startupTimeoutMs;
    for (;;) {
      if (!this.isAlive(pid)) {
        throw new Error(`opencode serve exited before it became healthy (${this.executable} serve --port ${port})`);
      }
      const health = await this.isHealthy(port);
      if (health) return { healthy: true, version: await this.readVersion(port) };
      if (this.now() >= deadline) {
        throw new Error(
          `opencode serve did not become healthy within ${this.startupTimeoutMs}ms (${this.executable} serve --port ${port})`,
        );
      }
      await this.sleep(this.healthPollIntervalMs);
    }
  }

  private async readVersion(port: number): Promise<string> {
    const response = await this.request(`http://127.0.0.1:${port}/global/health`);
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
    await this.signalAndWaitExit(entry.pid, (signal) => this.signaller.kill(entry.pid, signal));
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
    await this.signalAndWaitExit(entry.pid, (signal) => this.signaller.kill(entry.pid, signal));
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

  private async signalAndWaitExit(pid: number, sendSignal: (signal: NodeJS.Signals) => void): Promise<void> {
    if (!this.isAlive(pid)) {
      this.forgetChildrenForPid(pid);
      return;
    }

    let signal: NodeJS.Signals = "SIGTERM";
    try {
      sendSignal(signal);
    } catch (error) {
      if (!this.isAlive(pid)) {
        this.forgetChildrenForPid(pid);
        return;
      }
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
      if (!this.isAlive(pid)) {
        this.forgetChildrenForPid(pid);
        return;
      }
      const now = this.now();
      if (!forceSent && now >= forceAt) {
        signal = "SIGKILL";
        try {
          sendSignal(signal);
        } catch (error) {
          if (this.isAlive(pid)) {
            throw new OpenCodeServerDisposalError(
              `OpenCode process ${pid} could not be force-terminated; the resource may still be running`,
              "opencode_process_disposal_failed",
              pid,
              signal,
              false,
              error,
            );
          }
        }
        forceSent = true;
        if (!this.isAlive(pid)) {
          this.forgetChildrenForPid(pid);
          return;
        }
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
      if (!child.kill(signal) && this.isAlive(child.pid)) {
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

  private isAlive(pid: number): boolean {
    return this.signaller.isAlive(pid);
  }

  /**
   * Serialize registry mutations across `muximo run` processes in the same
   * instance so two panes starting concurrently share one server. Stale locks
   * (dead owner) are broken; a lock that stays contended returns a retryable
   * error and never runs the mutation without ownership.
   */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.options.registryFile}.lock`;
    const deadline = this.now() + this.registryLockTimeoutMs;
    for (;;) {
      let acquired = false;
      try {
        const fd = openSync(lockPath, "wx", 0o600);
        writeFileSync(fd, `${process.pid}\n`);
        closeSync(fd);
        acquired = true;
      } catch (error) {
        if (!isLockExistsError(error)) throw error;
        if (this.lockIsStale(lockPath)) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Another process may have released the lock first.
          }
          continue;
        }
      }
      if (!acquired) {
        if (this.now() >= deadline) {
          this.onLog?.("warn", "opencode.registry_lock_timeout", { path: lockPath });
          throw new OpenCodeRegistryLockTimeoutError(lockPath, this.registryLockTimeoutMs);
        }
        await this.sleep(Math.min(this.registryLockPollIntervalMs, Math.max(1, deadline - this.now())));
        continue;
      }
      try {
        return await operation();
      } finally {
        try {
          unlinkSync(lockPath);
        } catch {
          // The lock may already have been removed.
        }
      }
    }
  }

  private lockIsStale(lockPath: string): boolean {
    try {
      const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
      return !Number.isInteger(pid) || pid <= 0 || !this.isAlive(pid);
    } catch {
      return true;
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
  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // A muximod child is owned by the invoking account. EPERM therefore means
      // that the PID is not signalable by this lifecycle, so treat the record as
      // stale instead of blocking a new daemon behind an unrelated PID.
      void error;
      return false;
    }
  },
  kill(pid: number, signal: NodeJS.Signals): void {
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
