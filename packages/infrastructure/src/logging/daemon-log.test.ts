import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { type DaemonLogResult, readDaemonLog } from "./daemon-log.js";

type FixtureKey = "missing" | "empty" | "seeded" | "large" | "encoded";
type LogFixture = { root: string; logFile: string };
type LogInput = { lines?: number };
type LogContext = { state: string; logFile: string; lines: readonly string[] };

const cases = [
  {
    name: "reports a missing daemon log without creating the file",
    fixture: "missing",
    input: {},
    assert: [
      hasObserved<LogContext, DaemonLogResult>("state", "missing"),
      hasObserved<LogContext, DaemonLogResult>("lines", []),
    ],
  },
  {
    name: "reports an empty daemon log separately from a missing file",
    fixture: "empty",
    input: {},
    assert: [hasObserved<LogContext, DaemonLogResult>("state", "empty")],
  },
  {
    name: "returns only the requested number of most recent log lines",
    fixture: "seeded",
    input: { lines: 2 },
    assert: [
      hasObserved<LogContext, DaemonLogResult>("state", "available"),
      hasObserved<LogContext, DaemonLogResult>("lines", ["second", "third"]),
    ],
  },
  {
    name: "bounds a long line and keeps a large log read bounded",
    fixture: "large",
    input: { lines: 1 },
    assert: [
      hasObserved<LogContext, DaemonLogResult>("state", "available"),
      {
        name: "returns the newest bounded line",
        check: (_context: LogContext, result) => {
          if (!result.ok) return;
          const [line] = result.value.lines;
          if (!line) throw new Error("expected one log line");
          if (Buffer.byteLength(line, "utf8") > 64 * 1024) {
            throw new Error("daemon log line exceeded its limit");
          }
          if (!line.endsWith("...")) throw new Error("expected a truncated daemon log line");
        },
      },
    ],
  },
  {
    name: "keeps quote-heavy log frames below the control response limit",
    fixture: "encoded",
    input: { lines: 10_000 },
    assert: [
      hasObserved<LogContext, DaemonLogResult>("state", "available"),
      {
        name: "leaves JSON encoding headroom",
        check: (_context: LogContext, result) => {
          if (!result.ok) return;
          const frame = JSON.stringify({
            type: "daemon_log",
            requestId: "request",
            state: result.value.state,
            logFile: result.value.logFile,
            lines: result.value.lines,
          });
          if (Buffer.byteLength(frame, "utf8") > 4 * 1024 * 1024) {
            throw new Error("quote-heavy daemon log exceeded the control response limit after JSON encoding");
          }
        },
      },
    ],
  },
  {
    name: "rejects an unsafe line limit",
    fixture: "seeded",
    input: { lines: 10_001 },
    assert: [hasError<LogContext, DaemonLogResult>({ message: "daemon log line count must be between 1 and 10000" })],
  },
] satisfies readonly OperationCase<FixtureKey, LogInput, DaemonLogResult, LogContext>[];

const table: OperationTable<LogFixture, FixtureKey, LogInput, DaemonLogResult, LogContext> = {
  defaultFixture: () => createFixture("missing"),
  fixtures: {
    missing: () => createFixture("missing"),
    empty: () => createFixture("empty"),
    seeded: () => createFixture("seeded"),
    large: () => createFixture("large"),
    encoded: () => createFixture("encoded"),
  },
  cases,
  execute: (fixture, input) => readDaemonLog(fixture.logFile, input.lines),
  observe: (fixture, result) =>
    result.ok
      ? result.value
      : {
          state: "error",
          logFile: fixture.logFile,
          lines: [],
        },
};

function createFixture(kind: FixtureKey) {
  const root = mkdtempSync(join(tmpdir(), "muximo-daemon-log-"));
  const logFile = join(root, "muximod.log");
  if (kind === "empty") writeFileSync(logFile, "");
  if (kind === "seeded") writeFileSync(logFile, "first\nsecond\nthird\n");
  if (kind === "large") writeFileSync(logFile, `${"x".repeat(4 * 1024 * 1024)}\nnewest\n${"y".repeat(128 * 1024)}\n`);
  if (kind === "encoded")
    writeFileSync(logFile, `${Array.from({ length: 100 }, () => `${"\\".repeat(64 * 1024)}\n`).join("")}`);
  return {
    fixture: { root, logFile },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("daemon log infrastructure", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
