import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type Assertion,
  type FixtureHandle,
  noFixture,
  returns,
  runOperationTable,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import {
  buildDaemonSpawnArgs,
  consumeRestartMarker,
  disposeOwnedOpenCodeServers,
  formatMuximodHealthFailure,
  hasRestartMarker,
  writeRestartMarker,
  type MuximodCliOptions,
} from "./daemon.js";

type Input = { options: MuximodCliOptions; sourceEntry: string };
type Result = string[];
type Context = {};

const cases = [
  {
    name: "starts a detached child in foreground mode without recursing",
    input: {
      options: {
        host: "127.0.0.1",
        port: 49819,
        pidFile: "/private/tmp/muximo-daemon-test.pid",
        controlSocket: "/private/tmp/muximo-daemon-test.sock",
        muximodBaseUrl: "http://127.0.0.1:49819",
        logLevel: "debug",
        logFile: "/private/tmp/muximo-daemon-test.log",
      },
      sourceEntry: fileURLToPath(import.meta.url),
    },
    assert: [returns<Context, Result>([
      fileURLToPath(import.meta.url),
      "daemon",
      "start",
      "--foreground",
      "--host", "127.0.0.1",
      "--port", "49819",
      "--pid-file", "/private/tmp/muximo-daemon-test.pid",
      "--control-socket", "/private/tmp/muximo-daemon-test.sock",
      "--muximod-base-url", "http://127.0.0.1:49819",
      "--log-level", "debug",
      "--log-file", "/private/tmp/muximo-daemon-test.log",
    ])],
  },
] satisfies readonly OperationCase<"default", Input, Result, Context>[];

const table: OperationTable<undefined, "default", Input, Result, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => buildDaemonSpawnArgs(input.options, input.sourceEntry),
  observe: () => ({}),
};

describe("muximod daemon lifecycle", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

type HealthLogFixture = { logFile: string; prepare(records: readonly string[]): void };
type HealthLogInput = { records: readonly string[]; startedAt: number; pid?: number };
type HealthLogContext = { output: string };
type HealthLogFixtureKey = "default" | "missing";

const containsHealthOutput = (expected: string): Assertion<HealthLogContext, string> => ({
  name: `includes ${expected}`,
  check: (ctx) => expect(ctx.output).toContain(expected),
});

const excludesHealthOutput = (unexpected: string): Assertion<HealthLogContext, string> => ({
  name: `excludes ${unexpected}`,
  check: (ctx) => expect(ctx.output).not.toContain(unexpected),
});

const healthLogCases = [
  {
    name: "shows recent daemon warnings and errors with their codes",
    input: {
      records: [
        JSON.stringify({ timestamp: "2026-08-21T00:00:02.000Z", level: "warn", pid: 123, event: "tmux.default_session_failed", fields: { error: { message: "tmux unavailable" }, errorId: "warn-1" } }),
        JSON.stringify({ timestamp: "2026-08-21T00:00:03.000Z", level: "error", pid: 123, event: "daemon.start_failed", fields: { error: { message: "Failed to start server. Is port 45431 in use?", code: "EADDRINUSE" }, errorId: "error-1" } }),
        JSON.stringify({ timestamp: "2026-08-21T00:00:04.000Z", level: "info", pid: 123, event: "daemon.stopping", fields: {} }),
      ],
      startedAt: Date.parse("2026-08-21T00:00:01.000Z"),
      pid: 123,
    },
    assert: [
      containsHealthOutput("muximod recent diagnostics:"),
      containsHealthOutput("WARN tmux.default_session_failed: tmux unavailable errorId=warn-1"),
      containsHealthOutput("ERROR daemon.start_failed: Failed to start server. Is port 45431 in use? code=EADDRINUSE errorId=error-1"),
    ],
  },
  {
    name: "keeps the health failure useful when the log has no diagnostics",
    input: {
      records: [
        JSON.stringify({ timestamp: "2026-08-21T00:00:02.000Z", level: "info", pid: 123, event: "daemon.listening", fields: { host: "127.0.0.1", port: 4317 } }),
        "not-json",
      ],
      startedAt: Date.parse("2026-08-21T00:00:01.000Z"),
      pid: 123,
    },
    assert: [containsHealthOutput("muximod log: no recent warning or error records")],
  },
  {
    name: "keeps the health failure useful when the log file is missing",
    fixture: "missing",
    input: { records: [], startedAt: Date.parse("2026-08-21T00:00:01.000Z"), pid: 123 },
    assert: [containsHealthOutput("muximod log: no recent warning or error records")],
  },
  {
    name: "ignores diagnostics from before the health-check attempt and other processes",
    input: {
      records: [
        JSON.stringify({ timestamp: "2026-08-21T00:00:01.000Z", level: "error", pid: 123, event: "daemon.start_failed", fields: { error: { message: "old failure", code: "EADDRINUSE" }, errorId: "old" } }),
        JSON.stringify({ timestamp: "2026-08-21T00:00:03.000Z", level: "error", pid: 456, event: "daemon.start_failed", fields: { error: { message: "other process failure", code: "EADDRINUSE" }, errorId: "other" } }),
        JSON.stringify({ timestamp: "2026-08-21T00:00:04.000Z", level: "error", pid: 123, event: "daemon.start_failed", fields: { error: { message: "current failure", code: "EADDRINUSE" }, errorId: "current" } }),
      ],
      startedAt: Date.parse("2026-08-21T00:00:02.000Z"),
      pid: 123,
    },
    assert: [
      containsHealthOutput("ERROR daemon.start_failed: current failure code=EADDRINUSE errorId=current"),
      excludesHealthOutput("old failure"),
      excludesHealthOutput("other process failure"),
    ],
  },
] satisfies readonly OperationCase<HealthLogFixtureKey, HealthLogInput, string, HealthLogContext>[];

const createHealthLogFixture = (): FixtureHandle<HealthLogFixture> => {
  const root = mkdtempSync(join(tmpdir(), "muximo-daemon-health-log-"));
  return {
    fixture: {
      logFile: join(root, "muximod.log"),
      prepare: (records) => writeFileSync(join(root, "muximod.log"), records.length > 0 ? `${records.join("\n")}\n` : ""),
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const createMissingHealthLogFixture = (): FixtureHandle<HealthLogFixture> => {
  const root = mkdtempSync(join(tmpdir(), "muximo-daemon-health-log-missing-"));
  return {
    fixture: {
      logFile: join(root, "missing", "muximod.log"),
      prepare: () => undefined,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
};

const healthLogTable: OperationTable<HealthLogFixture, HealthLogFixtureKey, HealthLogInput, string, HealthLogContext> = {
  defaultFixture: createHealthLogFixture,
  fixtures: {
    default: createHealthLogFixture,
    missing: createMissingHealthLogFixture,
  },
  cases: healthLogCases,
  execute: (fixture, input) => {
    fixture.prepare(input.records);
    return formatMuximodHealthFailure("muximod did not become healthy at http://127.0.0.1:4317", fixture, {
      startedAt: input.startedAt,
      pid: input.pid,
    });
  },
  observe: (_fixture, result) => ({ output: result.ok ? result.value : "" }),
};

describe("muximod health-check diagnostics", () => {
  runOperationTable(it as unknown as TestRegistrar, healthLogTable);
});

type CleanupInput = { registryEntries: number; staleLock: boolean };
type CleanupResult = { registryAfter: Record<string, unknown>; completed: boolean };

const cleanupCases = [
  {
    name: "clears the owned-server registry when the daemon shuts down",
    input: { registryEntries: 1, staleLock: false },
    assert: [returns<CleanupContext, CleanupResult>({ registryAfter: {}, completed: true })],
  },
  {
    name: "completes even when a stale lock was left behind",
    input: { registryEntries: 1, staleLock: true },
    assert: [returns<CleanupContext, CleanupResult>({ registryAfter: {}, completed: true })],
  },
  {
    name: "handles an empty registry",
    input: { registryEntries: 0, staleLock: false },
    assert: [returns<CleanupContext, CleanupResult>({ registryAfter: {}, completed: true })],
  },
] satisfies readonly OperationCase<"default", CleanupInput, CleanupResult, CleanupContext>[];

type CleanupContext = {};

const cleanupTable: OperationTable<undefined, "default", CleanupInput, CleanupResult, CleanupContext> = {
  defaultFixture: noFixture(),
  cases: cleanupCases,
  execute: async (_fixture, input) => {
    const root = mkdtempSync(join(tmpdir(), "muximo-daemon-cleanup-"));
    const registryFile = join(root, "opencode-servers.json");
    try {
      if (input.registryEntries > 0) {
        writeFileSync(registryFile, JSON.stringify({
          "/workspace": { pid: 999_999, port: 41_000, version: "1.2.3", startedAt: "2026-08-15T00:00:00.000Z" },
        }));
      } else {
        writeFileSync(registryFile, "{}");
      }
      if (input.staleLock) writeFileSync(`${registryFile}.lock`, "999999\n");
      await disposeOwnedOpenCodeServers({ registryFile });
      return {
        registryAfter: JSON.parse(readFileSync(registryFile, "utf8")) as Record<string, unknown>,
        completed: true,
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  observe: () => ({}),
};

describe("muximod owned runtime cleanup", () => {
  runOperationTable(it as unknown as TestRegistrar, cleanupTable);
});

type MarkerInput = { refreshServers?: boolean };
type MarkerResult = { present: boolean; consumed: boolean | undefined; consumedAgain: boolean | undefined };

const markerCases = [
  {
    name: "a restart marker without refresh keeps the servers",
    input: {},
    assert: [returns<MarkerContext, MarkerResult>({ present: true, consumed: false, consumedAgain: undefined })],
  },
  {
    name: "a restart marker defaults to keeping servers and is consumed once",
    input: { refreshServers: false },
    assert: [returns<MarkerContext, MarkerResult>({ present: true, consumed: false, consumedAgain: undefined })],
  },
  {
    name: "a restart marker with refresh is reported once",
    input: { refreshServers: true },
    assert: [returns<MarkerContext, MarkerResult>({ present: true, consumed: true, consumedAgain: undefined })],
  },
] satisfies readonly OperationCase<"default", MarkerInput, MarkerResult, MarkerContext>[];

type MarkerContext = {};

const markerTable: OperationTable<undefined, "default", MarkerInput, MarkerResult, MarkerContext> = {
  defaultFixture: noFixture(),
  cases: markerCases,
  execute: (_fixture, input) => {
    const root = mkdtempSync(join(tmpdir(), "muximo-daemon-marker-"));
    try {
      const pidFile = join(root, "muximod.pid");
      writeRestartMarker(pidFile, input.refreshServers === true);
      const present = hasRestartMarker(pidFile);
      const consumed = consumeRestartMarker(pidFile);
      return {
        present,
        consumed,
        consumedAgain: consumeRestartMarker(pidFile),
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  observe: () => ({}),
};

describe("muximod restart marker", () => {
  runOperationTable(it as unknown as TestRegistrar, markerTable);
});
