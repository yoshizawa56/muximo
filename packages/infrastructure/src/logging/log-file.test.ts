import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assertion,
  hasError,
  hasNoError,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { followMuximodLogFile, type MuximodLogFileLine, readMuximodLogFile } from "./log-file.js";

function logLine(event: string, level = "info"): string {
  return JSON.stringify({
    timestamp: "2026-08-30T00:00:00.000Z",
    level,
    service: "muximod",
    pid: 402,
    processInstanceId: "instance",
    mode: "background",
    event,
    context: {},
    fields: { message: `message for ${event}` },
  });
}

type ReadInput = { lines?: number; filter?: string };
type ReadResult = ReturnType<typeof readMuximodLogFile>;
type ReadFixture = { logPath: string };
type ReadFixtureKey = "missing" | "empty" | "malformed";
type ReadContext = {
  state: string | undefined;
  events: readonly (string | undefined)[];
  raw: readonly string[];
};

function observesState(expected: "available" | "empty" | "missing"): Assertion<ReadContext, ReadResult> {
  return { name: `observes state ${expected}`, check: (ctx) => expect(ctx.state).toBe(expected) };
}

function observesEvents(expected: readonly (string | undefined)[]): Assertion<ReadContext, ReadResult> {
  return { name: `observes events ${expected.join(", ")}`, check: (ctx) => expect(ctx.events).toEqual(expected) };
}

function observesRaw(expected: readonly string[]): Assertion<ReadContext, ReadResult> {
  return { name: "observes raw lines", check: (ctx) => expect(ctx.raw).toEqual(expected) };
}

const readCases = [
  {
    name: "reads the recent tail with parsed records",
    input: {},
    assert: [
      hasNoError<ReadContext, ReadResult>(),
      observesState("available"),
      observesEvents(["first.started", "second.tick", "third.stopped"]),
    ],
  },
  {
    name: "limits the tail to the requested line count",
    input: { lines: 2 },
    assert: [hasNoError<ReadContext, ReadResult>(), observesEvents(["second.tick", "third.stopped"])],
  },
  {
    name: "filters lines by rendered text",
    input: { filter: "tick" },
    assert: [hasNoError<ReadContext, ReadResult>(), observesEvents(["second.tick"])],
  },
  {
    name: "filters lines by log level text",
    input: { filter: "warn" },
    assert: [hasNoError<ReadContext, ReadResult>(), observesEvents(["second.tick"])],
  },
  {
    name: "reports a missing log file",
    fixture: "missing" as const,
    input: {},
    assert: [hasNoError<ReadContext, ReadResult>(), observesState("missing"), observesEvents([])],
  },
  {
    name: "reports an empty log file",
    fixture: "empty" as const,
    input: {},
    assert: [hasNoError<ReadContext, ReadResult>(), observesState("empty"), observesEvents([])],
  },
  {
    name: "preserves unparseable lines as raw text",
    fixture: "malformed" as const,
    input: {},
    assert: [
      hasNoError<ReadContext, ReadResult>(),
      observesState("available"),
      observesEvents([undefined, "second.tick"]),
      observesRaw(["not json at all", logLine("second.tick")]),
    ],
  },
  {
    name: "rejects a line count outside the supported range",
    input: { lines: 0 },
    assert: [hasError<ReadContext, ReadResult>({ message: "daemon log line count must be between 1 and 10000" })],
  },
] satisfies readonly OperationCase<ReadFixtureKey, ReadInput, ReadResult, ReadContext>[];

const readTable: OperationTable<ReadFixture, ReadFixtureKey, ReadInput, ReadResult, ReadContext> = {
  defaultFixture: (registerCleanup) => {
    const fixture = createReadFixture(registerCleanup);
    const seed = [logLine("first.started"), logLine("second.tick", "warn"), logLine("third.stopped")].join("\n");
    writeFileSync(fixture.logPath, `${seed}\n`);
    return { fixture };
  },
  fixtures: {
    missing: (registerCleanup) => ({ fixture: createReadFixture(registerCleanup) }),
    empty: (registerCleanup) => {
      const fixture = createReadFixture(registerCleanup);
      writeFileSync(fixture.logPath, "");
      return { fixture };
    },
    malformed: (registerCleanup) => {
      const fixture = createReadFixture(registerCleanup);
      writeFileSync(fixture.logPath, `not json at all\n${logLine("second.tick")}\n`);
      return { fixture };
    },
  },
  cases: readCases,
  execute: (fixture, input) =>
    readMuximodLogFile({ logFile: fixture.logPath, lines: input.lines, filter: input.filter }),
  observe: (_fixture, outcome) => ({
    state: outcome.ok ? outcome.value.state : undefined,
    events: outcome.ok ? outcome.value.lines.map((line) => line.record?.event) : [],
    raw: outcome.ok ? outcome.value.lines.map((line) => line.raw) : [],
  }),
};

function createReadFixture(registerCleanup?: (cleanup: () => void) => void): ReadFixture {
  const root = mkdtempSync(join(tmpdir(), "muximod-log-file-"));
  registerCleanup?.(() => rmSync(root, { recursive: true, force: true }));
  return { logPath: join(root, "muximod.log") };
}

describe("muximod log file reading", () => {
  runOperationTable(it as unknown as TestRegistrar, readTable);
});

type FollowStep =
  | { type: "append"; content: string }
  | { type: "rotate"; content: string }
  | { type: "await"; count: number };

type FollowFixture = {
  logPath: string;
  lines: MuximodLogFileLine[];
  controller: AbortController;
};

type FollowResult = readonly MuximodLogFileLine[];
type FollowFixtureKey = "missing";
type FollowContext = {
  events: readonly (string | undefined)[];
  raw: readonly string[];
};

const followCases = [
  {
    name: "streams lines appended after the follow start",
    steps: [
      { type: "append", content: `${logLine("appended.tick")}\n` },
      { type: "await", count: 1 },
      { type: "append", content: `${logLine("appended.warn", "warn")}\n` },
      { type: "await", count: 2 },
    ],
    assert: [
      hasNoError<FollowContext, FollowResult>(),
      {
        name: "observes appended events",
        check: (ctx: FollowContext) => expect(ctx.events).toEqual(["appended.tick", "appended.warn"]),
      },
    ],
  },
  {
    name: "emits a partially written line once it is complete",
    steps: [
      { type: "append", content: logLine("partial.tick").slice(0, 20) },
      { type: "await", count: 0 },
      { type: "append", content: `${logLine("partial.tick").slice(20)}\n` },
      { type: "await", count: 1 },
    ],
    assert: [
      hasNoError<FollowContext, FollowResult>(),
      {
        name: "observes the completed raw line once",
        check: (ctx: FollowContext) => expect(ctx.raw).toEqual([logLine("partial.tick")]),
      },
      {
        name: "observes the completed event",
        check: (ctx: FollowContext) => expect(ctx.events).toEqual(["partial.tick"]),
      },
    ],
  },
  {
    name: "re-reads the log after rotation",
    steps: [
      { type: "append", content: `${logLine("before.rotate")}\n` },
      { type: "await", count: 1 },
      { type: "rotate", content: `${logLine("after.rotate")}\n` },
      { type: "await", count: 2 },
    ],
    assert: [
      hasNoError<FollowContext, FollowResult>(),
      {
        name: "observes lines from both log generations",
        check: (ctx: FollowContext) => expect(ctx.events).toEqual(["before.rotate", "after.rotate"]),
      },
    ],
  },
  {
    name: "waits for a log file that does not exist yet",
    fixture: "missing" as const,
    steps: [
      { type: "await", count: 0 },
      { type: "append", content: `${logLine("late.created")}\n` },
      { type: "await", count: 1 },
    ],
    assert: [
      hasNoError<FollowContext, FollowResult>(),
      {
        name: "observes the created line",
        check: (ctx: FollowContext) => expect(ctx.events).toEqual(["late.created"]),
      },
    ],
  },
] satisfies readonly ScenarioCase<FollowFixtureKey, FollowStep, FollowResult, FollowContext>[];

const followTable: ScenarioTable<FollowFixture, FollowFixtureKey, FollowStep, FollowResult, FollowContext> = {
  defaultFixture: (registerCleanup) => {
    const fixture = createFollowFixture(registerCleanup);
    writeFileSync(fixture.logPath, `${[logLine("seed.one"), logLine("seed.two")].join("\n")}\n`);
    return { fixture };
  },
  fixtures: {
    missing: (registerCleanup) => ({ fixture: createFollowFixture(registerCleanup) }),
  },
  cases: followCases,
  execute: async (fixture, steps) => {
    const followed = followMuximodLogFile({
      logFile: fixture.logPath,
      pollIntervalMs: 5,
      signal: fixture.controller.signal,
      onLines: (lines) => {
        fixture.lines.push(...lines);
      },
    });
    for (const step of steps) {
      if (step.type === "append") {
        appendFileSync(fixture.logPath, step.content);
        continue;
      }
      if (step.type === "rotate") {
        renameSync(fixture.logPath, `${fixture.logPath}.1`);
        writeFileSync(fixture.logPath, step.content);
        continue;
      }
      await waitFor(() => fixture.lines.length >= step.count);
    }
    fixture.controller.abort();
    await followed;
    return [...fixture.lines];
  },
  observe: (fixture, outcome) => {
    const lines = outcome.ok ? outcome.value : fixture.lines;
    return {
      events: lines.map((line) => line.record?.event),
      raw: lines.map((line) => line.raw),
    };
  },
};

function createFollowFixture(registerCleanup?: (cleanup: () => void) => void): FollowFixture {
  const root = mkdtempSync(join(tmpdir(), "muximod-log-follow-"));
  registerCleanup?.(() => rmSync(root, { recursive: true, force: true }));
  return {
    logPath: join(root, "muximod.log"),
    lines: [],
    controller: new AbortController(),
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for muximod log lines");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("muximod log file following", () => {
  runScenarioTable(it as unknown as TestRegistrar, followTable);
});
