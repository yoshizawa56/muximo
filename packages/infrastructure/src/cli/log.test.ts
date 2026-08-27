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
import { type DaemonLogResult, readDaemonLog } from "./log.js";

type FixtureKey = "missing" | "empty" | "seeded";
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
  return {
    fixture: { root, logFile },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("daemon log adapter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
