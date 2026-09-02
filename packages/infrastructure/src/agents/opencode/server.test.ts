import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  defaultOpenCodeRegistryFile,
  type OpenCodeServerEntry,
  OpenCodeServerManager,
  type SpawnedChild,
} from "./server.js";

type SpawnRecord = {
  command: string;
  args: string[];
  cwd: string;
  pid: number;
};

type RequestRecord = {
  url: string;
  directory: string | null;
};

type Harness = {
  registryFile: string;
  now: number;
  nextPid: number;
  healthyPorts: Set<number>;
  availablePorts: Set<number>;
  spawnRecords: SpawnRecord[];
  spawnEnvironments: NodeJS.ProcessEnv[];
  requestRecords: RequestRecord[];
  processObservations: Array<{ pid: number; expectedStartedAt: string | undefined }>;
  alivePids: Set<number>;
  unknownPids: Set<number>;
  unrefPids: number[];
  markHealthyOnSpawn: boolean;
};

type SeededEntry = {
  root?: string;
  pid?: number;
  port: number;
  version?: string;
  alive?: boolean;
  healthy?: boolean;
  portAvailable?: boolean;
  unknown?: boolean;
};

type ServerInput = {
  operation: "ensure" | "list" | "default-path";
  rawRegistry?: string;
  registryIsDirectory?: boolean;
  seededEntry?: SeededEntry;
  serverUrl?: string;
  externalServerAvailable?: boolean;
  healthOnSpawn?: boolean;
  startupTimeoutMs?: number;
  healthPollIntervalMs?: number;
  registryLockTimeoutMs?: number;
  registryLockPollIntervalMs?: number;
  requestTimeoutMs?: number;
  assertProcessIdentity?: boolean;
  healthRequestHangs?: boolean;
  staleLock?: boolean;
  contendedLock?: boolean;
  environment?: NodeJS.ProcessEnv;
};

type ServerResult = {
  entry: { workspaceRoot: string; pid?: number; port: number; version: string } | undefined;
  entries: { workspaceRoot: string; pid?: number; port: number; version: string }[];
  spawned: readonly SpawnRecord[];
  spawnEnvironment?: NodeJS.ProcessEnv;
  requestRecords: readonly RequestRecord[];
  processObservations?: readonly { pid: number; expectedStartedAt: string | undefined }[];
  unrefPids: readonly number[];
  registry: Record<string, unknown> | undefined;
  errorCode?: string;
  errorMessage?: string;
  causeMessage?: string;
  failure: "unavailable" | "registry-read" | "registry-lock" | "none";
};

type ServerFixture = {
  harness: Harness;
  result?: ServerResult;
};

function createHarness(): Harness {
  return {
    registryFile: join(mkdtempSync(join(tmpdir(), "muximo-opencode-server-")), "opencode-servers.json"),
    now: 0,
    nextPid: 1_000,
    healthyPorts: new Set(),
    availablePorts: new Set(),
    spawnRecords: [],
    spawnEnvironments: [],
    requestRecords: [],
    processObservations: [],
    alivePids: new Set(),
    unknownPids: new Set(),
    unrefPids: [],
    markHealthyOnSpawn: true,
  };
}

function createManager(harness: Harness, input: ServerInput): OpenCodeServerManager {
  return new OpenCodeServerManager({
    registryFile: harness.registryFile,
    executable: "opencode",
    serverUrl: input.serverUrl,
    startupTimeoutMs: input.startupTimeoutMs ?? 20,
    healthPollIntervalMs: input.healthPollIntervalMs ?? 5,
    registryLockTimeoutMs: input.registryLockTimeoutMs ?? 100,
    registryLockPollIntervalMs: input.registryLockPollIntervalMs ?? 5,
    requestTimeoutMs: input.requestTimeoutMs ?? 5,
    environment: input.environment,
    spawn: (command, args, options) => {
      if (input.environment !== undefined) harness.spawnEnvironments.push(options.env);
      return spawnRecord(harness, command, args, options.cwd);
    },
    allocatePort: async () => 49_152 + harness.spawnRecords.length,
    probePort: async (port) => harness.availablePorts.has(port),
    request: async (url, init) => {
      harness.requestRecords.push({
        url,
        directory: new Headers(init?.headers).get("x-opencode-directory"),
      });
      if (input.healthRequestHangs) return new Promise<Response>(() => {});
      const port = Number.parseInt(String(url).match(/127\.0\.0\.1:(\d+)/)?.[1] ?? "0", 10);
      if (
        !harness.healthyPorts.has(port) &&
        (input.serverUrl === undefined || input.externalServerAvailable === false)
      ) {
        return new Response("unhealthy", { status: 503 });
      }
      return new Response(JSON.stringify({ healthy: true, version: "1.2.3" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    signaller: {
      observe: (pid, expectedStartedAt) => {
        harness.processObservations.push({ pid, expectedStartedAt });
        return harness.unknownPids.has(pid) ? "unknown" : harness.alivePids.has(pid) ? "alive" : "dead";
      },
    },
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
  const port = Number.parseInt(args.at(-1) ?? "0", 10);
  harness.alivePids.add(pid);
  if (Number.isInteger(port) && harness.markHealthyOnSpawn) harness.healthyPorts.add(port);
  return {
    pid,
    unref: () => harness.unrefPids.push(pid),
  };
}

const anyStartedAt = "<started-at>";

function seed(harness: Harness, input: ServerInput): void {
  if (input.rawRegistry !== undefined) {
    mkdirSync(join(harness.registryFile, ".."), { recursive: true });
    writeFileSync(harness.registryFile, input.rawRegistry);
  }
  if (input.registryIsDirectory === true) mkdirSync(harness.registryFile);
  if (input.seededEntry !== undefined) {
    const seeded = input.seededEntry;
    const root = seeded.root ?? "/ws";
    const entry: OpenCodeServerEntry = {
      workspaceRoot: root,
      port: seeded.port,
      version: seeded.version ?? "1.0.0",
      ...(seeded.pid === undefined ? {} : { pid: seeded.pid, startedAt: "2026-08-15T00:00:00.000Z" }),
    };
    writeFileSync(harness.registryFile, JSON.stringify({ [root]: entry }));
    if (seeded.alive && seeded.pid !== undefined) harness.alivePids.add(seeded.pid);
    if (seeded.unknown && seeded.pid !== undefined) harness.unknownPids.add(seeded.pid);
    if (seeded.healthy) harness.healthyPorts.add(seeded.port);
    if (seeded.portAvailable) harness.availablePorts.add(seeded.port);
  }
  if (input.staleLock) writeFileSync(`${harness.registryFile}.lock`, JSON.stringify({ pid: 42 }));
  if (input.contendedLock) writeFileSync(`${harness.registryFile}.lock`, JSON.stringify({ pid: process.pid }));
}

function snapshotRegistry(harness: Harness): Record<string, unknown> | undefined {
  try {
    const registry = JSON.parse(readFileSync(harness.registryFile, "utf8")) as Record<string, Record<string, unknown>>;
    return Object.fromEntries(
      Object.entries(registry).map(([root, entry]) => [
        root,
        entry.startedAt === undefined ? entry : { ...entry, startedAt: anyStartedAt },
      ]),
    );
  } catch {
    return undefined;
  }
}

function resultEntry(entry: OpenCodeServerEntry): NonNullable<ServerResult["entry"]> {
  return {
    workspaceRoot: entry.workspaceRoot,
    ...(entry.pid === undefined ? {} : { pid: entry.pid }),
    port: entry.port,
    version: entry.version,
  };
}

function classifyFailure(error: unknown): ServerResult["failure"] {
  const code = errorCode(error);
  if (code === "opencode_server_unavailable") return "unavailable";
  if (code === "opencode_registry_lock_timeout") return "registry-lock";
  if (error instanceof Error && error.message.includes("registry could not be read")) return "registry-read";
  return "none";
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

const cases = [
  {
    name: "uses the shared registry path override before the selected instance directory",
    input: {
      operation: "default-path" as const,
      environment: { MUXIMO_OPENCODE_REGISTRY_FILE: "/state/opencode.json" },
    },
    assert: [
      returns<ServerResult, ServerResult>({
        entry: undefined,
        entries: [],
        spawned: [],
        requestRecords: [],
        unrefPids: [],
        registry: undefined,
        failure: "none",
      }),
    ],
  },
  {
    name: "preserves a registry read failure cause",
    input: { operation: "ensure" as const, registryIsDirectory: true },
    assert: [hasError<ServerResult, ServerResult>({ message: /registry could not be read/ })],
  },
  {
    name: "bootstraps a detached server and records a non-owning reference",
    input: { operation: "ensure" as const },
    assert: [
      returns<ServerResult, ServerResult>({
        entry: { workspaceRoot: "/ws", pid: 1_000, port: 49_152, version: "1.2.3" },
        entries: [],
        spawned: [
          {
            command: "opencode",
            args: ["serve", "--hostname", "127.0.0.1", "--port", "49152"],
            cwd: "/ws",
            pid: 1_000,
          },
        ],
        requestRecords: [{ url: "http://127.0.0.1:49152/global/health", directory: "/ws" }],
        unrefPids: [1_000],
        registry: {
          "/ws": { workspaceRoot: "/ws", pid: 1_000, port: 49_152, version: "1.2.3", startedAt: anyStartedAt },
        },
        failure: "none",
      }),
    ],
  },
  {
    name: "passes the injected environment and workspace directory to the server health request",
    input: {
      operation: "ensure" as const,
      environment: { MUXIMO_OPENCODE_BIN: "/opt/opencode", MUXIMO_WORKTREE_ID: "worktree-1" },
    },
    assert: [
      returns<ServerResult, ServerResult>({
        entry: { workspaceRoot: "/ws", pid: 1_000, port: 49_152, version: "1.2.3" },
        entries: [],
        spawned: [
          {
            command: "opencode",
            args: ["serve", "--hostname", "127.0.0.1", "--port", "49152"],
            cwd: "/ws",
            pid: 1_000,
          },
        ],
        spawnEnvironment: { MUXIMO_OPENCODE_BIN: "/opt/opencode", MUXIMO_WORKTREE_ID: "worktree-1" },
        requestRecords: [{ url: "http://127.0.0.1:49152/global/health", directory: "/ws" }],
        unrefPids: [1_000],
        registry: {
          "/ws": { workspaceRoot: "/ws", pid: 1_000, port: 49_152, version: "1.2.3", startedAt: anyStartedAt },
        },
        failure: "none",
      }),
    ],
  },
  {
    name: "reuses a healthy shared reference without a PID or spawn",
    input: {
      operation: "ensure" as const,
      seededEntry: { port: 7_000, version: "1.0.0", healthy: true },
    },
    assert: [
      returns<ServerResult, ServerResult>({
        entry: { workspaceRoot: "/ws", port: 7_000, version: "1.2.3" },
        entries: [],
        spawned: [],
        requestRecords: [{ url: "http://127.0.0.1:7000/global/health", directory: "/ws" }],
        unrefPids: [],
        registry: { "/ws": { workspaceRoot: "/ws", port: 7_000, version: "1.2.3" } },
        failure: "none",
      }),
    ],
  },
  {
    name: "removes a dead bootstrap identity without signalling the old PID",
    input: {
      operation: "ensure" as const,
      seededEntry: { pid: 42, port: 7_000, alive: false, healthy: false, portAvailable: true },
    },
    assert: [
      returns<ServerResult, ServerResult>({
        entry: { workspaceRoot: "/ws", pid: 1_000, port: 7_000, version: "1.2.3" },
        entries: [],
        spawned: [
          { command: "opencode", args: ["serve", "--hostname", "127.0.0.1", "--port", "7000"], cwd: "/ws", pid: 1_000 },
        ],
        requestRecords: [
          { url: "http://127.0.0.1:7000/global/health", directory: "/ws" },
          { url: "http://127.0.0.1:7000/global/health", directory: "/ws" },
        ],
        unrefPids: [1_000],
        registry: {
          "/ws": { workspaceRoot: "/ws", pid: 1_000, port: 7_000, version: "1.2.3", startedAt: anyStartedAt },
        },
        failure: "none",
      }),
    ],
  },
  {
    name: "does not replace or signal a live unhealthy shared server",
    input: {
      operation: "ensure" as const,
      seededEntry: { pid: 42, port: 7_000, alive: true, healthy: false, portAvailable: false },
      startupTimeoutMs: 10,
    },
    assert: [
      hasError<ServerResult, ServerResult>({ code: "opencode_server_unavailable", retryable: true }),
      hasObserved<ServerResult, ServerResult>("spawned", []),
    ],
  },
  {
    name: "does not replace an unknown shared server even when its port is available",
    input: {
      operation: "ensure" as const,
      seededEntry: { pid: 42, unknown: true, port: 7_000, portAvailable: true },
      startupTimeoutMs: 10,
    },
    assert: [
      hasError<ServerResult, ServerResult>({ code: "opencode_server_unavailable", retryable: true }),
      hasObserved<ServerResult, ServerResult>("spawned", []),
    ],
  },
  {
    name: "uses the recorded process start identity while waiting for a stale server",
    input: {
      operation: "ensure" as const,
      assertProcessIdentity: true,
      seededEntry: { pid: 42, port: 7_000, healthy: false, portAvailable: true },
    },
    assert: [
      returns<ServerResult, ServerResult>({
        entry: { workspaceRoot: "/ws", pid: 1_000, port: 7_000, version: "1.2.3" },
        entries: [],
        spawned: [
          {
            command: "opencode",
            args: ["serve", "--hostname", "127.0.0.1", "--port", "7000"],
            cwd: "/ws",
            pid: 1_000,
          },
        ],
        requestRecords: [
          { url: "http://127.0.0.1:7000/global/health", directory: "/ws" },
          { url: "http://127.0.0.1:7000/global/health", directory: "/ws" },
        ],
        processObservations: [
          { pid: 42, expectedStartedAt: "2026-08-15T00:00:00.000Z" },
          { pid: 42, expectedStartedAt: "2026-08-15T00:00:00.000Z" },
        ],
        unrefPids: [1_000],
        registry: {
          "/ws": { workspaceRoot: "/ws", pid: 1_000, port: 7_000, version: "1.2.3", startedAt: anyStartedAt },
        },
        failure: "none",
      }),
    ],
  },
  {
    name: "connects to an explicitly configured external server without spawning",
    input: { operation: "ensure" as const, rawRegistry: "not-json", serverUrl: "http://127.0.0.1:4096" },
    assert: [
      returns<ServerResult, ServerResult>({
        entry: { workspaceRoot: "/ws", port: 4_096, version: "1.2.3" },
        entries: [],
        spawned: [],
        requestRecords: [{ url: "http://127.0.0.1:4096/global/health", directory: "/ws" }],
        unrefPids: [],
        registry: undefined,
        failure: "none",
      }),
    ],
  },
  {
    name: "fails clearly when the explicitly configured external server is unavailable",
    input: {
      operation: "ensure" as const,
      serverUrl: "http://127.0.0.1:4096",
      externalServerAvailable: false,
      startupTimeoutMs: 10,
    },
    assert: [
      hasError<ServerResult, ServerResult>({ code: "opencode_server_unavailable", message: /4096/ }),
      hasObserved<ServerResult, ServerResult>("spawned", []),
    ],
  },
  {
    name: "reclaims a lock left by a dead daemon before bootstrapping",
    input: { operation: "ensure" as const, staleLock: true },
    assert: [
      hasObserved<ServerResult, ServerResult>("entry", {
        workspaceRoot: "/ws",
        pid: 1_000,
        port: 49_152,
        version: "1.2.3",
      }),
      hasObserved<ServerResult, ServerResult>("failure", "none"),
    ],
  },
  {
    name: "returns a retryable lock error without mutating a contended registry",
    input: { operation: "ensure" as const, contendedLock: true, registryLockTimeoutMs: 10 },
    assert: [hasError<ServerResult, ServerResult>({ code: "opencode_registry_lock_timeout", retryable: true })],
  },
] satisfies readonly OperationCase<"default", ServerInput, ServerResult, ServerResult>[];

const table: OperationTable<ServerFixture, "default", ServerInput, ServerResult, ServerResult> = {
  defaultFixture: () => ({ fixture: { harness: createHarness() } }),
  cases,
  execute: async (fixture, input) => {
    const harness = fixture.harness;
    seed(harness, input);
    if (input.operation === "default-path") {
      const selected = defaultOpenCodeRegistryFile(input.environment);
      const result: ServerResult = {
        entry: undefined,
        entries: [],
        spawned: [],
        requestRecords: selected === "/state/opencode.json" ? [] : [{ url: selected, directory: null }],
        unrefPids: [],
        registry: undefined,
        failure: "none",
      };
      fixture.result = result;
      return result;
    }

    const manager = createManager(harness, input);
    let entry: OpenCodeServerEntry | undefined;
    let entries: OpenCodeServerEntry[] = [];
    try {
      if (input.operation === "ensure") entry = await manager.ensure("/ws");
      else entries = manager.list();
    } catch (caught) {
      const result: ServerResult = {
        entry: undefined,
        entries: [],
        spawned: harness.spawnRecords,
        spawnEnvironment: harness.spawnEnvironments[0],
        requestRecords: harness.requestRecords,
        ...(input.assertProcessIdentity ? { processObservations: harness.processObservations } : {}),
        unrefPids: harness.unrefPids,
        registry: snapshotRegistry(harness),
        errorCode: errorCode(caught),
        errorMessage: caught instanceof Error ? caught.message : String(caught),
        causeMessage: caught instanceof Error && caught.cause instanceof Error ? caught.cause.message : undefined,
        failure: classifyFailure(caught),
      };
      fixture.result = result;
      throw caught;
    }

    const registry = snapshotRegistry(harness);
    const result: ServerResult = {
      entry: entry === undefined ? undefined : resultEntry(entry),
      entries: entries.map(resultEntry),
      spawned: harness.spawnRecords,
      ...(harness.spawnEnvironments[0] === undefined ? {} : { spawnEnvironment: harness.spawnEnvironments[0] }),
      requestRecords: harness.requestRecords,
      ...(input.assertProcessIdentity ? { processObservations: harness.processObservations } : {}),
      unrefPids: harness.unrefPids,
      registry,
      failure: "none",
    };
    fixture.result = result;
    return result;
  },
  observe: (fixture) => fixture.result ?? emptyResult(),
};

describe("opencode server manager", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function emptyResult(): ServerResult {
  return {
    entry: undefined,
    entries: [],
    spawned: [],
    requestRecords: [],
    unrefPids: [],
    registry: undefined,
    failure: "none",
  };
}
