import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  type Assertion,
  type FixtureHandle,
  hasNoError,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import {
  createLogger,
  createRotatingFileSink,
  createStreamSink,
  errorFields,
  errorMessage,
  formatHumanRecord,
  type LogRecord,
  parseLogLevel,
} from "./index.js";

type LogKey = "metadata" | "human" | "rotate" | "stream" | "level" | "hostile";
type LogStep = { [Key in LogKey]: { type: Key } }[LogKey];
type LogResult = { done: true };
type LogFixture = {
  logger?: ReturnType<typeof createLogger>;
  records: LogRecord[];
  output: string;
  outputStream?: Writable;
  root?: string;
  logPath?: string;
  writes: number;
  record?: LogRecord;
  fields?: unknown;
  errorText?: string;
};
type LogContext = {
  records: readonly LogRecord[];
  output: string;
  files: readonly string[];
  logPath?: string;
  writes: number;
  fields?: unknown;
  errorText?: string;
};

const metadataAssertion: Assertion<LogContext, LogResult> = {
  name: "adds process and child metadata while redacting fields",
  check: (ctx) =>
    expect(ctx.records[0]).toMatchObject({
      timestamp: "2026-08-14T00:00:00.000Z",
      service: "muximo-cli",
      pid: 123,
      processInstanceId: "process-1",
      mode: "attached",
      event: "session.started",
      context: { command: "run", sessionId: "session-1" },
      fields: { backend: "claude", token: "[REDACTED]" },
    }),
};

const humanAssertion: Assertion<LogContext, LogResult> = {
  name: "renders stack traces only in verbose mode",
  check: (ctx) => {
    const [normal, verbose] = ctx.output.split("---verbose---");
    expect(normal).toContain("[muximo-cli]");
    expect(normal).toContain("unexpected error: failed to connect");
    expect(normal).not.toContain("at main");
    expect(verbose).toContain("at main");
  },
};

const rotateAssertion: Assertion<LogContext, LogResult> = {
  name: "writes bounded private JSON log files",
  check: (ctx) => {
    expect(ctx.files).toContain("muximod.log");
    expect(ctx.files.length).toBeLessThanOrEqual(3);
    expect(JSON.parse(readFileSync(ctx.logPath!, "utf8").trim())).toMatchObject({
      service: "muximod",
      event: "daemon.health_check",
    });
    expect(statSync(ctx.logPath!).mode & 0o777).toBe(0o600);
    expect(statSync(join(ctx.logPath!, "..")).mode & 0o777).toBe(0o700);
  },
};

const streamAssertion: Assertion<LogContext, LogResult> = {
  name: "isolates stream failures from logger calls",
  check: (ctx) => expect(ctx.writes).toBe(1),
};

const levelAssertion: Assertion<LogContext, LogResult> = {
  name: "filters records by configured level",
  check: (ctx) => {
    expect(ctx.output).not.toContain("command.started");
    expect(ctx.output).toContain("command.warning");
    expect(ctx.output).toContain("debug:debug");
    expect(ctx.output).toContain("fallback:info");
  },
};

const hostileAssertion: Assertion<LogContext, LogResult> = {
  name: "keeps hostile errors out of diagnostics",
  check: (ctx) => {
    expect(ctx.errorText).toBe("unknown error");
    expect(JSON.stringify(ctx.fields)).not.toContain("sensitive prompt");
    expect(JSON.stringify(ctx.fields)).not.toContain("secret output");
  },
};

const cases = [
  {
    name: "adds process metadata and immutable child context",
    fixture: "metadata",
    steps: [{ type: "metadata" }],
    assert: [hasNoError<LogContext, LogResult>(), metadataAssertion],
  },
  {
    name: "renders human output without a stack by default and includes it in verbose mode",
    fixture: "human",
    steps: [{ type: "human" }],
    assert: [hasNoError<LogContext, LogResult>(), humanAssertion],
  },
  {
    name: "writes background logs as JSON and rotates bounded files",
    fixture: "rotate",
    steps: [{ type: "rotate" }],
    assert: [hasNoError<LogContext, LogResult>(), rotateAssertion],
  },
  {
    name: "isolates synchronous and asynchronous stream failures",
    fixture: "stream",
    steps: [{ type: "stream" }],
    assert: [hasNoError<LogContext, LogResult>(), streamAssertion],
  },
  {
    name: "filters records by level and parses configured levels",
    fixture: "level",
    steps: [{ type: "level" }],
    assert: [hasNoError<LogContext, LogResult>(), levelAssertion],
  },
  {
    name: "keeps hostile errors and subprocess diagnostics safe",
    fixture: "hostile",
    steps: [{ type: "hostile" }],
    assert: [hasNoError<LogContext, LogResult>(), hostileAssertion],
  },
] satisfies readonly ScenarioCase<LogKey, LogStep, LogResult, LogContext>[];

const table: ScenarioTable<LogFixture, LogKey, LogStep, LogResult, LogContext> = {
  defaultFixture: () => createLoggingFixture("metadata"),
  fixtures: {
    metadata: () => createLoggingFixture("metadata"),
    human: () => createLoggingFixture("human"),
    rotate: () => createLoggingFixture("rotate"),
    stream: () => createLoggingFixture("stream"),
    level: () => createLoggingFixture("level"),
    hostile: () => createLoggingFixture("hostile"),
  },
  cases,
  execute: async (fixture, steps) => {
    if (steps.length !== 1) throw new Error("logger scenario requires exactly one step");
    switch (steps[0]!.type) {
      case "metadata": {
        const child = fixture.logger!.child({ command: "run", sessionId: "session-1" });
        child.debug("session.started", { backend: "claude", token: "do-not-log" });
        return { done: true };
      }
      case "human": {
        const record: LogRecord = {
          timestamp: "2026-08-14T00:00:00.000Z",
          level: "error",
          service: "muximo-cli",
          pid: 123,
          processInstanceId: "process-1",
          mode: "attached",
          event: "process.unhandled_error",
          context: {},
          fields: {
            message: "unexpected error: failed to connect",
            error: { name: "Error", message: "failed to connect", stack: "Error: failed to connect\n    at main" },
          },
        };
        fixture.output = `${formatHumanRecord(record)}\n---verbose---\n${formatHumanRecord(record, true)}`;
        return { done: true };
      }
      case "rotate":
        for (let index = 0; index < 8; index += 1)
          fixture.logger!.info("daemon.health_check", { attempt: index, ok: true });
        return { done: true };
      case "stream":
        fixture.logger!.error("process.unhandled_error");
        await new Promise<void>((resolve) => setImmediate(resolve));
        fixture.logger!.error("process.unhandled_error");
        return { done: true };
      case "level":
        fixture.logger!.info("command.started");
        fixture.logger!.warn("command.warning");
        fixture.output += `debug:${parseLogLevel("debug")}\\nfallback:${parseLogLevel("invalid", "info")}`;
        return { done: true };
      case "hostile": {
        const hostile = new Proxy(
          {},
          {
            ownKeys() {
              throw new Error("ownKeys should not escape diagnostics");
            },
          },
        );
        fixture.fields = errorFields(hostile);
        const subprocessError = new Error("Command failed: backend --prompt sensitive prompt\\nsecret output");
        Object.defineProperty(subprocessError, "cause", {
          configurable: true,
          get() {
            throw new Error("cause accessor failed");
          },
        });
        fixture.fields = errorFields(subprocessError);
        const throwingMessage = new Error("fallback");
        Object.defineProperty(throwingMessage, "message", {
          configurable: true,
          get() {
            throw new Error("message accessor failed");
          },
        });
        fixture.errorText = errorMessage(throwingMessage);
        return { done: true };
      }
      default:
        return assertNever(steps[0]!);
    }
  },
  observe: (fixture) => ({
    records: [...fixture.records],
    output: fixture.output + (fixture.outputStream instanceof Writable ? readStreamOutput(fixture.outputStream) : ""),
    files: fixture.root ? readdirSync(join(fixture.root, "logs")).filter((file) => file.startsWith("muximod.log")) : [],
    logPath: fixture.logPath,
    writes: fixture.writes,
    fields: fixture.fields,
    errorText: fixture.errorText,
  }),
};

describe("structured logger", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

function createLoggingFixture(kind: LogKey): FixtureHandle<LogFixture> {
  const fixture: LogFixture = { records: [], output: "", writes: 0 };
  if (kind === "metadata") {
    fixture.logger = createLogger({
      service: "muximo-cli",
      mode: "attached",
      level: "debug",
      sink: { write: (record) => fixture.records.push(record) },
      processInstanceId: "process-1",
      pid: 123,
      clock: () => new Date("2026-08-14T00:00:00.000Z"),
    });
  } else if (kind === "human") {
    // The record is created in execute so observation remains read-only.
  } else if (kind === "rotate") {
    fixture.root = mkdtempSync(join(tmpdir(), "muximo-logging-test-"));
    fixture.logPath = join(fixture.root, "logs", "muximod.log");
    fixture.logger = createLogger({
      service: "muximod",
      mode: "background",
      level: "info",
      sink: createRotatingFileSink(fixture.logPath, { maxBytes: 240, maxFiles: 2 }),
      processInstanceId: "process-1",
      pid: 123,
    });
  } else if (kind === "stream") {
    fixture.outputStream = new Writable({
      write(_chunk, _encoding, callback) {
        fixture.writes += 1;
        callback(new Error("stream closed"));
      },
    });
    fixture.logger = createLogger({
      service: "muximo-cli",
      mode: "attached",
      level: "debug",
      sink: createStreamSink(fixture.outputStream, "human"),
    });
  } else if (kind === "level") {
    fixture.outputStream = new Writable({
      write(chunk, _encoding, callback) {
        fixture.output += chunk.toString();
        callback();
      },
    });
    fixture.logger = createLogger({
      service: "muximo-cli",
      mode: "attached",
      level: "warn",
      sink: createStreamSink(fixture.outputStream, "human"),
    });
  }
  return {
    fixture,
    cleanup: () => {
      fixture.logger?.close();
      if (fixture.root) rmSync(fixture.root, { recursive: true, force: true });
    },
  };
}

function readStreamOutput(_stream: Writable): string {
  return "";
}

function assertNever(value: never): never {
  throw new Error(`unhandled logger step: ${String(value)}`);
}
