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

export type OpenCodeServerManagerOptions = {
  registryFile: string;
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
  logFileDirectory?: string;
  signaller?: ProcessSignaller;
  onLog?: OpenCodeLog;
};

export const openCodeServerDefaultTimeoutMs = 15_000;
export const openCodeServerHealthPollMs = 100;

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
  private readonly logFileDirectory: string;
  private readonly signaller: ProcessSignaller;
  private readonly onLog: OpenCodeLog | undefined;
  private readonly children = new Set<SpawnedChild>();

  public constructor(private readonly options: OpenCodeServerManagerOptions) {
    this.executable = options.executable ?? "opencode";
    this.spawn = options.spawn ?? ((command, args, spawnOptions) => spawnServe(command, args, spawnOptions));
    this.request = options.request ?? ((url, init) => fetch(url, init));
    this.allocatePort = options.allocatePort ?? allocateLoopbackPort;
    this.probePort = options.probePort ?? probeLoopbackPort;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? openCodeServerHealthPollMs;
    this.startupTimeoutMs = options.startupTimeoutMs ?? openCodeServerDefaultTimeoutMs;
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
        this.disposeEntry(existing);
        delete registry[workspaceRoot];
      }

      const port = existing ? await this.allocatePreferredPort(existing.port) : await this.allocatePort();
      const child = this.spawnServer(workspaceRoot, port);
      let health: { healthy: boolean; version: string } | undefined;
      try {
        health = await this.waitForHealth(port, child.pid);
      } catch (error) {
        this.disposeChild(child);
        throw error;
      }
      const entry: OpenCodeServerEntry = {
        workspaceRoot,
        pid: child.pid,
        port,
        version: health.version,
        startedAt: new Date().toISOString(),
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

  /** Stop and forget the owned server for a project root. */
  public async dispose(workspaceRoot: string): Promise<boolean> {
    return this.withFileLock(async () => {
      const registry = this.readRegistry();
      const entry = registry[workspaceRoot];
      if (!entry) return false;
      delete registry[workspaceRoot];
      this.writeRegistry(registry);
      this.disposeEntry(entry);
      return true;
    });
  }

  public async disposeAll(): Promise<void> {
    await this.withFileLock(async () => {
      const registry = this.readRegistry();
      for (const entry of Object.values(registry)) this.disposeEntry(entry);
      this.writeRegistry({});
    });
  }

  public list(): OpenCodeServerEntry[] {
    return Object.values(this.readRegistry());
  }

  private readRegistry(): OpenCodeServerRegistry {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.options.registryFile, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const registry: OpenCodeServerRegistry = {};
        for (const [root, entry] of Object.entries(parsed as Record<string, unknown>)) {
          const value = entry as Partial<OpenCodeServerEntry>;
          if (typeof value?.port === "number" && typeof value.pid === "number" && typeof root === "string") {
            registry[root] = {
              workspaceRoot: root,
              pid: value.pid,
              port: value.port,
              version: typeof value.version === "string" ? value.version : "",
              startedAt: typeof value.startedAt === "string" ? value.startedAt : new Date().toISOString(),
            };
          }
        }
        return registry;
      }
    } catch {
      // A missing or unreadable registry is treated as empty.
    }
    return {};
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
      env: process.env,
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
    const deadline = Date.now() + this.startupTimeoutMs;
    for (;;) {
      if (!this.isAlive(pid)) {
        throw new Error(`opencode serve exited before it became healthy (${this.executable} serve --port ${port})`);
      }
      const health = await this.isHealthy(port);
      if (health) return { healthy: true, version: await this.readVersion(port) };
      if (Date.now() >= deadline) {
        throw new Error(
          `opencode serve did not become healthy within ${this.startupTimeoutMs}ms (${this.executable} serve --port ${port})`,
        );
      }
      await sleep(this.healthPollIntervalMs);
    }
  }

  private async readVersion(port: number): Promise<string> {
    try {
      const response = await this.request(`http://127.0.0.1:${port}/global/health`);
      if (!response.ok) return "";
      const body: unknown = await response.json().catch(() => undefined);
      return body && typeof body === "object" && typeof (body as { version?: unknown }).version === "string"
        ? (body as { version: string }).version
        : "";
    } catch {
      return "";
    }
  }

  private disposeEntry(entry: OpenCodeServerEntry): void {
    this.onLog?.("debug", "opencode.server_disposing", { pid: entry.pid, port: entry.port });
    void this.signalAndWaitExit(entry.pid);
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
    await this.signalAndWaitExit(entry.pid);
    const port = await this.allocatePreferredPort(entry.port);
    const child = this.spawnServer(workspaceRoot, port);
    try {
      const health = await this.waitForHealth(port, child.pid);
      return {
        workspaceRoot,
        pid: child.pid,
        port,
        version: health.version,
        startedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.disposeChild(child);
      this.onLog?.("warn", "opencode.server_refresh_failed", {
        workspaceRoot,
        port,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async signalAndWaitExit(pid: number): Promise<void> {
    if (!this.isAlive(pid)) return;
    try {
      this.signaller.kill(pid, "SIGTERM");
    } catch (_error) {
      // EPERM means the process belongs to another user; never force-stop a
      // server Muximo does not own.
      this.onLog?.("warn", "opencode.server_not_owned", { pid });
      return;
    }
    setTimeout(() => {
      if (this.isAlive(pid)) {
        try {
          this.signaller.kill(pid, "SIGKILL");
        } catch {
          // The process exited during the grace period.
        }
      }
    }, 2_000).unref?.();
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && this.isAlive(pid)) {
      await sleep(50);
    }
  }

  private async allocatePreferredPort(preferred: number): Promise<number> {
    if (await this.probePort(preferred)) return preferred;
    return this.allocatePort();
  }

  private disposeChild(child: SpawnedChild): void {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child already exited.
    }
    this.children.delete(child);
  }

  private isAlive(pid: number): boolean {
    return this.signaller.isAlive(pid);
  }

  /**
   * Serialize registry mutations across `muximo run` processes in the same
   * instance so two panes starting concurrently share one server. Stale locks
   * (dead owner) are broken; a lock that stays contended is abandoned rather
   * than blocking the pane forever.
   */
  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.options.registryFile}.lock`;
    const deadline = Date.now() + 5_000;
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
        if (Date.now() >= deadline) {
          this.onLog?.("warn", "opencode.registry_lock_timeout", { path: lockPath });
          return operation();
        }
        await sleep(50);
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

const defaultSignaller: ProcessSignaller = {
  isAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to another user; treat it
      // as alive so an unowned server is never force-stopped.
      return error instanceof Error && "code" in error && error.code === "EPERM";
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
