import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { type OpenCodeServerEntry, OpenCodeServerManager, type SpawnedChild } from "./server.js";

type SpawnRecord = {
  command: string;
  args: string[];
  cwd: string;
  pid: number;
};

type Harness = {
  registryFile: string;
  now: number;
  nextPid: number;
  ports: number[];
  healthyPorts: Set<number>;
  availablePorts: Set<number>;
  spawnRecords: SpawnRecord[];
  alivePids: Set<number>;
  killed: { pid: number; signal: string }[];
  childrenDieImmediately: boolean;
  markHealthyOnSpawn: boolean;
};

type ProcessExitMode = "term" | "kill" | "never";
type SeededEntry = {
  root?: string;
  pid: number;
  port: number;
  alive?: boolean;
  healthy?: boolean;
  portAvailable?: boolean;
};

type ServerInput = {
  rawRegistry?: string;
  seededEntry?: SeededEntry;
  seededEntries?: readonly SeededEntry[];
  seededAlive?: boolean;
  seededHealthy?: boolean;
  seededPortAvailable?: boolean;
  healthOnSpawn?: boolean;
  portSequence?: number[];
  startupTimeoutMs?: number;
  healthPollIntervalMs?: number;
  shutdownTimeoutMs?: number;
  shutdownGracePeriodMs?: number;
  shutdownPollIntervalMs?: number;
  registryLockTimeoutMs?: number;
  registryLockPollIntervalMs?: number;
  operation: "ensure" | "dispose" | "dispose-all" | "dispose-missing" | "refresh-all";
  staleLock?: boolean;
  contendedLock?: boolean;
  unownedKillThrows?: boolean;
  processExit?: ProcessExitMode;
  processExitByPid?: Readonly<Record<number, ProcessExitMode>>;
  childrenDieImmediately?: boolean;
};

type ServerResult = {
  entry: { workspaceRoot: string; pid: number; port: number; version: string } | undefined;
  entries?: { workspaceRoot: string; pid: number; port: number; version: string }[];
  spawned: readonly SpawnRecord[];
  killed: readonly { pid: number; signal: string }[];
  registry: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
  retryable?: boolean;
  failure:
    | "health_timeout"
    | "server_exited"
    | "registry_lock_timeout"
    | "disposal_timeout"
    | "disposal_failed"
    | "none";
};

function createHarness(): Harness {
  return {
    registryFile: join(mkdtempSync(join(tmpdir(), "muximo-opencode-server-")), "opencode-servers.json"),
    now: 0,
    nextPid: 1_000,
    ports: [],
    healthyPorts: new Set(),
    availablePorts: new Set(),
    spawnRecords: [],
    alivePids: new Set(),
    killed: [],
    childrenDieImmediately: false,
    markHealthyOnSpawn: true,
  };
}

function createManager(harness: Harness, input: ServerInput): OpenCodeServerManager {
  return new OpenCodeServerManager({
    registryFile: harness.registryFile,
    executable: "opencode",
    startupTimeoutMs: input.startupTimeoutMs ?? 500,
    healthPollIntervalMs: input.healthPollIntervalMs ?? 5,
    spawn: (command, args, options) => spawnRecord(harness, command, args, options.cwd),
    allocatePort: async () => {
      const port = input.portSequence?.[harness.ports.length] ?? 49_152 + harness.ports.length;
      harness.ports.push(port);
      return port;
    },
    probePort: async (port) => harness.availablePorts.has(port),
    request: async (url) => {
      const port = Number.parseInt(String(url).match(/127\.0\.0\.1:(\d+)/)?.[1] ?? "0", 10);
      if (!harness.healthyPorts.has(port)) return new Response("unhealthy", { status: 503 });
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    signaller: {
      isAlive: (pid) => harness.alivePids.has(pid),
      kill: (pid, signal) => {
        if (input.unownedKillThrows) throw new Error("EPERM: operation not permitted");
        harness.killed.push({ pid, signal });
        const processExit = input.processExitByPid?.[pid] ?? input.processExit;
        if (processExit !== "never" && (processExit !== "kill" || signal === "SIGKILL")) {
          harness.alivePids.delete(pid);
        }
      },
    },
    shutdownTimeoutMs: input.shutdownTimeoutMs,
    shutdownGracePeriodMs: input.shutdownGracePeriodMs,
    shutdownPollIntervalMs: input.shutdownPollIntervalMs,
    registryLockTimeoutMs: input.registryLockTimeoutMs,
    registryLockPollIntervalMs: input.registryLockPollIntervalMs,
    now: () => harness.now,
    sleep: async (milliseconds) => {
      harness.now += milliseconds;
    },
  });
}

function spawnRecord(harness: Harness, command: string, args: string[], cwd: string): SpawnedChild {
  const pid = harness.nextPid;
  harness.nextPid += 1;
  harness.spawnRecords.push({ command, args, cwd, pid });
  const port = Number.parseInt(args[args.length - 1] ?? "0", 10);
  if (harness.childrenDieImmediately) {
    return { pid, kill: () => true, unref: () => undefined, on: () => undefined };
  }
  harness.alivePids.add(pid);
  if (Number.isInteger(port) && harness.markHealthyOnSpawn) harness.healthyPorts.add(port);
  return {
    pid,
    kill: (signal) => {
      harness.alivePids.delete(pid);
      harness.healthyPorts.delete(port);
      void signal;
      return true;
    },
    unref: () => undefined,
    on: () => undefined,
  };
}

const expectAnyStartedAt = "__ANY_STARTED_AT__";

type EmptyContext = {};

const cases = [
  {
    name: "starts an owned server and records the entry",
    input: { operation: "ensure" as const },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: { workspaceRoot: "/ws", pid: 1_000, port: 49_152, version: "1.2.3" },
        spawned: [
          {
            command: "opencode",
            args: ["serve", "--hostname", "127.0.0.1", "--port", "49152"],
            cwd: "/ws",
            pid: 1_000,
          },
        ],
        killed: [],
        registry: { "/ws": { pid: 1_000, port: 49_152, version: "1.2.3", startedAt: expectAnyStartedAt } },
        failure: "none",
      }),
    ],
  },
  {
    name: "rejects a registry entry without the current format",
    input: {
      operation: "ensure" as const,
      rawRegistry: JSON.stringify({
        "/ws": { pid: 42, port: 7_000, version: "1.2.3", startedAt: "2026-08-15T00:00:00.000Z" },
      }),
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        spawned: [],
        killed: [],
        registry: { "/ws": { pid: 42, port: 7_000, version: "1.2.3", startedAt: expectAnyStartedAt } },
        errorMessage: "OpenCode server registry entry is invalid: /ws",
        failure: "health_timeout",
      }),
    ],
  },
  {
    name: "rejects a registry entry with an unknown field",
    input: {
      operation: "ensure" as const,
      rawRegistry: JSON.stringify({
        "/ws": {
          workspaceRoot: "/ws",
          pid: 42,
          port: 7_000,
          version: "1.2.3",
          startedAt: "2026-08-15T00:00:00.000Z",
          legacy: true,
        },
      }),
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        spawned: [],
        killed: [],
        registry: {
          "/ws": {
            pid: 42,
            port: 7_000,
            version: "1.2.3",
            startedAt: expectAnyStartedAt,
            legacy: true,
          },
        },
        errorMessage: "OpenCode server registry entry is invalid: /ws",
        failure: "health_timeout",
      }),
    ],
  },
  {
    name: "reuses a healthy registered server without spawning",
    input: {
      operation: "ensure" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: true,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: { workspaceRoot: "/ws", pid: 42, port: 7_000, version: "1.2.3" },
        spawned: [],
        killed: [],
        registry: { "/ws": { pid: 42, port: 7_000, version: "1.2.3", startedAt: expectAnyStartedAt } },
        failure: "none",
      }),
    ],
  },
  {
    name: "restarts on the registered port when the registered process is gone",
    input: {
      operation: "ensure" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: false,
      seededHealthy: false,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: { workspaceRoot: "/ws", pid: 1_000, port: 7_000, version: "1.2.3" },
        spawned: [
          { command: "opencode", args: ["serve", "--hostname", "127.0.0.1", "--port", "7000"], cwd: "/ws", pid: 1_000 },
        ],
        killed: [],
        registry: { "/ws": { pid: 1_000, port: 7_000, version: "1.2.3", startedAt: expectAnyStartedAt } },
        failure: "none",
      }),
    ],
  },
  {
    name: "restarts on the registered port when the registered server is unhealthy",
    input: {
      operation: "ensure" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: false,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: { workspaceRoot: "/ws", pid: 1_000, port: 7_000, version: "1.2.3" },
        spawned: [
          { command: "opencode", args: ["serve", "--hostname", "127.0.0.1", "--port", "7000"], cwd: "/ws", pid: 1_000 },
        ],
        killed: [{ pid: 42, signal: "SIGTERM" }],
        registry: { "/ws": { pid: 1_000, port: 7_000, version: "1.2.3", startedAt: expectAnyStartedAt } },
        failure: "none",
      }),
    ],
  },
  {
    name: "falls back to a fresh port when the registered port is occupied",
    input: {
      operation: "ensure" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: false,
      seededHealthy: false,
      seededPortAvailable: false,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: { workspaceRoot: "/ws", pid: 1_000, port: 49_152, version: "1.2.3" },
        spawned: [
          {
            command: "opencode",
            args: ["serve", "--hostname", "127.0.0.1", "--port", "49152"],
            cwd: "/ws",
            pid: 1_000,
          },
        ],
        killed: [],
        registry: { "/ws": { pid: 1_000, port: 49_152, version: "1.2.3", startedAt: expectAnyStartedAt } },
        failure: "none",
      }),
    ],
  },
  {
    name: "dispose stops the owned server and forgets the entry",
    input: {
      operation: "dispose" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: true,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        spawned: [],
        killed: [{ pid: 42, signal: "SIGTERM" }],
        registry: {},
        failure: "none",
      }),
    ],
  },
  {
    name: "dispose does not signal a server it does not own",
    input: {
      operation: "dispose" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: true,
      unownedKillThrows: true,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        spawned: [],
        killed: [],
        registry: { "/ws": { pid: 42, port: 7_000, version: "1.2.3", startedAt: expectAnyStartedAt } },
        errorCode: "opencode_process_disposal_failed",
        retryable: false,
        failure: "disposal_failed",
      }),
    ],
  },
  {
    name: "dispose waits for confirmed process exit before reporting success",
    input: {
      operation: "dispose" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: true,
      processExit: "kill" as const,
      shutdownTimeoutMs: 60,
      shutdownGracePeriodMs: 10,
      shutdownPollIntervalMs: 5,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        spawned: [],
        killed: [
          { pid: 42, signal: "SIGTERM" },
          { pid: 42, signal: "SIGKILL" },
        ],
        registry: {},
        failure: "none",
      }),
    ],
  },
  {
    name: "dispose reports a retryable timeout while the process remains alive",
    input: {
      operation: "dispose" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: true,
      processExit: "never" as const,
      shutdownTimeoutMs: 40,
      shutdownGracePeriodMs: 10,
      shutdownPollIntervalMs: 5,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        spawned: [],
        killed: [
          { pid: 42, signal: "SIGTERM" },
          { pid: 42, signal: "SIGKILL" },
        ],
        registry: { "/ws": { pid: 42, port: 7_000, version: "1.2.3", startedAt: expectAnyStartedAt } },
        errorCode: "opencode_process_disposal_timeout",
        retryable: true,
        failure: "disposal_timeout",
      }),
    ],
  },
  {
    name: "dispose of an unknown root is a no-op",
    input: { operation: "dispose-missing" as const },
    assert: [
      returns<EmptyContext, ServerResult>({ entry: undefined, spawned: [], killed: [], registry: {}, failure: "none" }),
    ],
  },
  {
    name: "fails with a diagnostic when the server never becomes healthy",
    input: {
      operation: "ensure" as const,
      healthOnSpawn: false,
      startupTimeoutMs: 60,
      healthPollIntervalMs: 10,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        spawned: [
          {
            command: "opencode",
            args: ["serve", "--hostname", "127.0.0.1", "--port", "49152"],
            cwd: "/ws",
            pid: 1_000,
          },
        ],
        killed: [],
        registry: {},
        failure: "health_timeout",
      }),
    ],
  },
  {
    name: "fails when the server exits before becoming healthy",
    input: {
      operation: "ensure" as const,
      childrenDieImmediately: true,
      startupTimeoutMs: 100,
      healthPollIntervalMs: 10,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        spawned: [
          {
            command: "opencode",
            args: ["serve", "--hostname", "127.0.0.1", "--port", "49152"],
            cwd: "/ws",
            pid: 1_000,
          },
        ],
        killed: [],
        registry: {},
        failure: "server_exited",
      }),
    ],
  },
  {
    name: "proceeds when a stale lock is left behind",
    input: {
      operation: "ensure" as const,
      staleLock: true,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: { workspaceRoot: "/ws", pid: 1_000, port: 49_152, version: "1.2.3" },
        spawned: [
          {
            command: "opencode",
            args: ["serve", "--hostname", "127.0.0.1", "--port", "49152"],
            cwd: "/ws",
            pid: 1_000,
          },
        ],
        killed: [],
        registry: { "/ws": { pid: 1_000, port: 49_152, version: "1.2.3", startedAt: expectAnyStartedAt } },
        failure: "none",
      }),
    ],
  },
  {
    name: "fails retryably without mutating when the registry lock remains contended",
    input: {
      operation: "ensure" as const,
      contendedLock: true,
      registryLockTimeoutMs: 30,
      registryLockPollIntervalMs: 5,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        spawned: [],
        killed: [],
        registry: {},
        errorCode: "opencode_registry_lock_timeout",
        retryable: true,
        failure: "registry_lock_timeout",
      }),
    ],
  },
  {
    name: "disposeAll clears the registry only after every process exits",
    input: {
      operation: "dispose-all" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: true,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        entries: [],
        spawned: [],
        killed: [{ pid: 42, signal: "SIGTERM" }],
        registry: {},
        failure: "none",
      }),
    ],
  },
  {
    name: "disposeAll reports a timeout and retains ownership while a process remains alive",
    input: {
      operation: "dispose-all" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: true,
      processExit: "never" as const,
      shutdownTimeoutMs: 40,
      shutdownGracePeriodMs: 10,
      shutdownPollIntervalMs: 5,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        entries: [{ workspaceRoot: "/ws", pid: 42, port: 7_000, version: "1.2.3" }],
        spawned: [],
        killed: [
          { pid: 42, signal: "SIGTERM" },
          { pid: 42, signal: "SIGKILL" },
        ],
        registry: { "/ws": { pid: 42, port: 7_000, version: "1.2.3", startedAt: expectAnyStartedAt } },
        errorCode: "opencode_process_disposal_timeout",
        retryable: true,
        failure: "disposal_timeout",
      }),
    ],
  },
  {
    name: "disposeAll removes successful entries before retaining a failed owner",
    input: {
      operation: "dispose-all" as const,
      seededEntries: [
        { root: "/finished", pid: 42, port: 7_000, alive: true, healthy: true },
        { root: "/stuck", pid: 43, port: 7_001, alive: true, healthy: true },
      ],
      processExitByPid: { 42: "term", 43: "never" },
      shutdownTimeoutMs: 40,
      shutdownGracePeriodMs: 10,
      shutdownPollIntervalMs: 5,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        entries: [{ workspaceRoot: "/stuck", pid: 43, port: 7_001, version: "1.2.3" }],
        spawned: [],
        killed: [
          { pid: 42, signal: "SIGTERM" },
          { pid: 43, signal: "SIGTERM" },
          { pid: 43, signal: "SIGKILL" },
        ],
        registry: { "/stuck": { pid: 43, port: 7_001, version: "1.2.3", startedAt: expectAnyStartedAt } },
        errorCode: "opencode_process_disposal_timeout",
        retryable: true,
        failure: "disposal_timeout",
      }),
    ],
  },
  {
    name: "replacement refuses to start while the previous process remains alive",
    input: {
      operation: "ensure" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: false,
      processExit: "never" as const,
      shutdownTimeoutMs: 40,
      shutdownGracePeriodMs: 10,
      shutdownPollIntervalMs: 5,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        spawned: [],
        killed: [
          { pid: 42, signal: "SIGTERM" },
          { pid: 42, signal: "SIGKILL" },
        ],
        registry: { "/ws": { pid: 42, port: 7_000, version: "1.2.3", startedAt: expectAnyStartedAt } },
        errorCode: "opencode_process_disposal_timeout",
        retryable: true,
        failure: "disposal_timeout",
      }),
    ],
  },
  {
    name: "refreshAll restarts every owned server on its registered port",
    input: {
      operation: "refresh-all" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: true,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        entries: [{ workspaceRoot: "/ws", pid: 1_000, port: 7_000, version: "1.2.3" }],
        spawned: [
          { command: "opencode", args: ["serve", "--hostname", "127.0.0.1", "--port", "7000"], cwd: "/ws", pid: 1_000 },
        ],
        killed: [{ pid: 42, signal: "SIGTERM" }],
        registry: { "/ws": { pid: 1_000, port: 7_000, version: "1.2.3", startedAt: expectAnyStartedAt } },
        failure: "none",
      }),
    ],
  },
  {
    name: "refreshAll respawns a server whose process is already gone",
    input: {
      operation: "refresh-all" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: false,
      seededHealthy: false,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        entries: [{ workspaceRoot: "/ws", pid: 1_000, port: 7_000, version: "1.2.3" }],
        spawned: [
          { command: "opencode", args: ["serve", "--hostname", "127.0.0.1", "--port", "7000"], cwd: "/ws", pid: 1_000 },
        ],
        killed: [],
        registry: { "/ws": { pid: 1_000, port: 7_000, version: "1.2.3", startedAt: expectAnyStartedAt } },
        failure: "none",
      }),
    ],
  },
  {
    name: "refreshAll drops a root whose replacement server never becomes healthy",
    input: {
      operation: "refresh-all" as const,
      seededEntry: { root: "/ws", pid: 42, port: 7_000 },
      seededAlive: true,
      seededHealthy: false,
      healthOnSpawn: false,
      startupTimeoutMs: 60,
      healthPollIntervalMs: 10,
    },
    assert: [
      returns<EmptyContext, ServerResult>({
        entry: undefined,
        entries: [],
        spawned: [
          { command: "opencode", args: ["serve", "--hostname", "127.0.0.1", "--port", "7000"], cwd: "/ws", pid: 1_000 },
        ],
        killed: [{ pid: 42, signal: "SIGTERM" }],
        registry: {},
        failure: "none",
      }),
    ],
  },
] satisfies readonly OperationCase<"default", ServerInput, ServerResult, EmptyContext>[];

const table: OperationTable<undefined, "default", ServerInput, ServerResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: async (_fixture, input) => {
    const harness = createHarness();
    try {
      if (input.staleLock) writeFileSync(`${harness.registryFile}.lock`, "999999\n");
      if (input.contendedLock) {
        writeFileSync(`${harness.registryFile}.lock`, `${process.pid}\n`);
        harness.alivePids.add(process.pid);
      }
      if (input.rawRegistry !== undefined) writeFileSync(harness.registryFile, input.rawRegistry);
      const seededEntries = input.seededEntries ?? (input.seededEntry ? [input.seededEntry] : []);
      if (seededEntries.length > 0) {
        const registry = Object.fromEntries(
          seededEntries.map((seeded) => [
            seeded.root ?? "/ws",
            {
              workspaceRoot: seeded.root ?? "/ws",
              pid: seeded.pid,
              port: seeded.port,
              version: "1.2.3",
              startedAt: "2026-08-15T00:00:00.000Z",
            },
          ]),
        );
        writeFileSync(harness.registryFile, JSON.stringify(registry));
        for (const seeded of seededEntries) {
          const alive = seeded.alive ?? input.seededAlive ?? false;
          const healthy = seeded.healthy ?? input.seededHealthy ?? false;
          const portAvailable = seeded.portAvailable ?? input.seededPortAvailable !== false;
          if (alive) harness.alivePids.add(seeded.pid);
          if (healthy) harness.healthyPorts.add(seeded.port);
          if (portAvailable) harness.availablePorts.add(seeded.port);
        }
      }
      if (input.healthOnSpawn === false) harness.healthyPorts.clear();
      harness.childrenDieImmediately = input.childrenDieImmediately ?? false;
      harness.markHealthyOnSpawn = input.healthOnSpawn !== false;

      const manager = createManager(harness, input);
      let entry: OpenCodeServerEntry | undefined;
      let failure: ServerResult["failure"] = "none";
      let errorCode: string | undefined;
      let retryable: boolean | undefined;
      let errorMessage: string | undefined;
      try {
        if (input.operation === "dispose") {
          const disposed = await manager.dispose("/ws");
          if (!disposed) throw new Error("dispose returned false");
        } else if (input.operation === "dispose-all") {
          await manager.disposeAll();
        } else if (input.operation === "dispose-missing") {
          const disposed = await manager.dispose("/ws");
          if (disposed) throw new Error("dispose returned true");
        } else if (input.operation === "refresh-all") {
          await manager.refreshAll();
        } else {
          entry = await manager.ensure("/ws");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (input.rawRegistry !== undefined) errorMessage = message;
        const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
        if (
          code === "opencode_registry_lock_timeout" ||
          code === "opencode_process_disposal_timeout" ||
          code === "opencode_process_disposal_failed"
        ) {
          errorCode = code;
          retryable = error && typeof error === "object" && "retryable" in error ? error.retryable === true : false;
        }
        failure =
          code === "opencode_registry_lock_timeout"
            ? "registry_lock_timeout"
            : code === "opencode_process_disposal_timeout"
              ? "disposal_timeout"
              : code === "opencode_process_disposal_failed"
                ? "disposal_failed"
                : message.includes("exited before")
                  ? "server_exited"
                  : "health_timeout";
      }
      const registry = existsSync(harness.registryFile)
        ? (JSON.parse(readFileSync(harness.registryFile, "utf8")) as Record<string, unknown>)
        : {};
      const normalizedRegistry = normalizeRegistry(registry);
      const result: ServerResult = {
        entry: entry
          ? { workspaceRoot: entry.workspaceRoot, pid: entry.pid, port: entry.port, version: entry.version }
          : undefined,
        spawned: harness.spawnRecords,
        killed: harness.killed,
        registry: normalizedRegistry,
        ...(errorCode ? { errorCode, retryable } : {}),
        ...(errorMessage ? { errorMessage } : {}),
        failure,
      };
      if (input.operation === "refresh-all") {
        result.entries = Object.entries(normalizedRegistry).map(([root, value]) => ({
          workspaceRoot: root,
          pid: (value as { pid: number }).pid,
          port: (value as { port: number }).port,
          version: (value as { version: string }).version,
        }));
      } else if (input.operation === "dispose-all") {
        result.entries = Object.entries(normalizedRegistry).map(([root, value]) => ({
          workspaceRoot: root,
          pid: (value as { pid: number }).pid,
          port: (value as { port: number }).port,
          version: (value as { version: string }).version,
        }));
      }
      return result;
    } finally {
      rmSync(dirname(harness.registryFile), { recursive: true, force: true });
    }
  },
  observe: () => ({}),
};

describe("opencode server manager", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function normalizeRegistry(registry: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [root, entry] of Object.entries(registry)) {
    const { workspaceRoot: _workspaceRoot, startedAt, ...rest } = entry as Record<string, unknown>;
    normalized[root] = { ...rest, startedAt: startedAt === undefined ? undefined : expectAnyStartedAt };
  }
  return normalized;
}

function dirname(path: string): string {
  return path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
}
