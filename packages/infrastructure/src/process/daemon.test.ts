import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonOptions, DaemonPidRecord, ProcessResult } from "@muximo/application";
import {
  hasError,
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { buildMuximodDaemonEnvironment, MuximodDaemonProcess, restartMarkerPath } from "./daemon.js";

type EmptyContext = {};

type EnvironmentInput = {
  origins?: readonly string[];
  environment: NodeJS.ProcessEnv;
};

const environmentCases = [
  {
    name: "writes exact sorted browser origins for a server child",
    input: {
      origins: ["https://web.example", "http://127.0.0.1:5227"],
      environment: { MUXIMOD_ALLOWED_ORIGINS: "stale-value", PATH: "/usr/bin" },
    },
    assert: [
      returns<EmptyContext, NodeJS.ProcessEnv>({
        MUXIMOD_ALLOWED_ORIGINS: "http://127.0.0.1:5227,https://web.example",
        PATH: "/usr/bin",
      }),
    ],
  },
  {
    name: "preserves local no-Origin mode when no origin is configured",
    input: { environment: { PATH: "/usr/bin" } },
    assert: [returns<EmptyContext, NodeJS.ProcessEnv>({ PATH: "/usr/bin" })],
  },
  {
    name: "rejects wildcard browser origins",
    input: { origins: ["*"] as const, environment: {} },
    assert: [hasError<EmptyContext, NodeJS.ProcessEnv>({ message: "wildcard browser origins are not allowed" })],
  },
] satisfies readonly OperationCase<"default" | "wildcard", EnvironmentInput, NodeJS.ProcessEnv, EmptyContext>[];

const environmentTable: OperationTable<
  undefined,
  "default" | "wildcard",
  EnvironmentInput,
  NodeJS.ProcessEnv,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  fixtures: { default: noFixture(), wildcard: noFixture() },
  cases: environmentCases,
  execute: (_fixture, input) => buildMuximodDaemonEnvironment({ allowedOrigins: input.origins }, input.environment),
  observe: () => ({}),
};

type ProcessFixture = {
  calls: Array<{ executable: string; args: readonly string[]; environment: NodeJS.ProcessEnv }>;
  args?: readonly string[];
  environment?: Pick<
    NodeJS.ProcessEnv,
    "MUXIMOD_HOST" | "MUXIMOD_PORT" | "MUXIMOD_PID_FILE" | "MUXIMOD_CONTROL_SOCKET" | "MUXIMO_LOG_LEVEL"
  >;
};

const processCases = [
  {
    name: "starts the server process without forwarding lifecycle argv",
    input: {
      options: {
        host: "127.0.0.1",
        port: 4317,
        pidFile: "/tmp/muximod.pid",
        controlSocket: "/tmp/muximod.sock",
        logLevel: "info",
      },
    },
    assert: [
      returns<ProcessFixture, ProcessResult>({ code: 0, interrupted: false }),
      hasObserved<ProcessFixture, ProcessResult>("args", []),
      hasObserved<ProcessFixture, ProcessResult>("environment", {
        MUXIMOD_HOST: "127.0.0.1",
        MUXIMOD_PORT: "4317",
        MUXIMOD_PID_FILE: "/tmp/muximod.pid",
        MUXIMOD_CONTROL_SOCKET: "/tmp/muximod.sock",
        MUXIMO_LOG_LEVEL: "info",
      }),
    ],
  },
] satisfies readonly OperationCase<"default", { options: DaemonOptions }, ProcessResult, ProcessFixture>[];

const processTable: OperationTable<
  ProcessFixture,
  "default",
  { options: DaemonOptions },
  ProcessResult,
  ProcessFixture
> = {
  defaultFixture: () => ({ fixture: { calls: [] } }),
  cases: processCases,
  execute: async (fixture, input) => {
    const daemon = new MuximodDaemonProcess({
      environment: { PATH: "/usr/bin" },
      executable: "muximod-test",
      run: async (executable, args, environment) => {
        fixture.calls.push({ executable, args, environment });
        return { code: 0, interrupted: false };
      },
    });
    const status = await daemon.runForeground(input.options);
    fixture.args = fixture.calls[0]?.args;
    const environment = fixture.calls[0]?.environment;
    fixture.environment = {
      MUXIMOD_HOST: environment?.MUXIMOD_HOST,
      MUXIMOD_PORT: environment?.MUXIMOD_PORT,
      MUXIMOD_PID_FILE: environment?.MUXIMOD_PID_FILE,
      MUXIMOD_CONTROL_SOCKET: environment?.MUXIMOD_CONTROL_SOCKET,
      MUXIMO_LOG_LEVEL: environment?.MUXIMO_LOG_LEVEL,
    };
    return status;
  },
  observe: (fixture) => ({
    args: fixture.args,
    environment: fixture.environment,
    calls: fixture.calls,
  }),
};

type FileFixture = { root: string; daemon: MuximodDaemonProcess };
type FileInput = { content?: string };
type PidResult = DaemonPidRecord | undefined;

const pidCases = [
  {
    name: "returns no pid record when the file is absent",
    input: {},
    assert: [returns<FileFixture, PidResult>(undefined)],
  },
  {
    name: "reads the current pid record format",
    input: {
      content: JSON.stringify({ pid: 42, host: "127.0.0.1", port: 4_317, startedAt: "2026-08-23T00:00:00.000Z" }),
    },
    assert: [
      returns<FileFixture, PidResult>({
        pid: 42,
        host: "127.0.0.1",
        port: 4_317,
        startedAt: "2026-08-23T00:00:00.000Z",
      }),
    ],
  },
  {
    name: "rejects a pid record without the startedAt field",
    input: { content: JSON.stringify({ pid: 42, host: "127.0.0.1", port: 4_317 }) },
    assert: [hasError<FileFixture, PidResult>({ message: /pid file has an invalid format/ })],
  },
  {
    name: "rejects a pid record with an unknown field",
    input: {
      content: JSON.stringify({
        pid: 42,
        host: "127.0.0.1",
        port: 4_317,
        startedAt: "2026-08-23T00:00:00.000Z",
        legacy: true,
      }),
    },
    assert: [hasError<FileFixture, PidResult>({ message: /pid file has an invalid format/ })],
  },
  {
    name: "rejects malformed pid JSON",
    input: { content: "not-json" },
    assert: [hasError<FileFixture, PidResult>({ message: /pid file contains invalid JSON/ })],
  },
] satisfies readonly OperationCase<"default", FileInput, PidResult, FileFixture>[];

const pidTable: OperationTable<FileFixture, "default", FileInput, PidResult, FileFixture> = {
  defaultFixture: () => {
    const root = mkdtempSync(join(tmpdir(), "muximo-daemon-pid-"));
    return {
      fixture: { root, daemon: new MuximodDaemonProcess({ executable: "muximod-test" }) },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  },
  cases: pidCases,
  execute: (fixture, input) => {
    const path = join(fixture.root, "muximod.pid");
    if (input.content !== undefined) writeFileSync(path, input.content);
    return fixture.daemon.readPidRecord(path);
  },
  observe: (fixture) => fixture,
};

type RestartInput = { content?: string };
type RestartResult = boolean | undefined;

const restartMarkerCases = [
  {
    name: "returns no refresh instruction when the restart marker is absent",
    input: {},
    assert: [returns<FileFixture, RestartResult>(undefined)],
  },
  {
    name: "reads a restart marker that requests server refresh",
    input: {
      content: JSON.stringify({ pid: 42, refreshServers: true, startedAt: "2026-08-23T00:00:00.000Z" }),
    },
    assert: [returns<FileFixture, RestartResult>(true)],
  },
  {
    name: "reads a restart marker that skips server refresh",
    input: {
      content: JSON.stringify({ pid: 42, refreshServers: false, startedAt: "2026-08-23T00:00:00.000Z" }),
    },
    assert: [returns<FileFixture, RestartResult>(false)],
  },
  {
    name: "rejects a restart marker without its current refresh field",
    input: { content: JSON.stringify({ pid: 42, startedAt: "2026-08-23T00:00:00.000Z" }) },
    assert: [hasError<FileFixture, RestartResult>({ message: /restart marker has an invalid format/ })],
  },
  {
    name: "rejects a restart marker with an unknown field",
    input: {
      content: JSON.stringify({
        pid: 42,
        refreshServers: false,
        startedAt: "2026-08-23T00:00:00.000Z",
        legacy: true,
      }),
    },
    assert: [hasError<FileFixture, RestartResult>({ message: /restart marker has an invalid format/ })],
  },
] satisfies readonly OperationCase<"default", RestartInput, RestartResult, FileFixture>[];

const restartMarkerTable: OperationTable<FileFixture, "default", RestartInput, RestartResult, FileFixture> = {
  defaultFixture: () => {
    const root = mkdtempSync(join(tmpdir(), "muximo-daemon-restart-"));
    return {
      fixture: { root, daemon: new MuximodDaemonProcess({ executable: "muximod-test" }) },
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  },
  cases: restartMarkerCases,
  execute: (fixture, input) => {
    const pidFile = join(fixture.root, "muximod.pid");
    const path = restartMarkerPath(pidFile);
    if (input.content !== undefined) writeFileSync(path, input.content);
    return fixture.daemon.consumeRestartMarker(pidFile);
  },
  observe: (fixture) => fixture,
};

describe("muximod process adapter", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, environmentTable);
  runOperationTable(register, processTable);
  runOperationTable(register, pidTable);
  runOperationTable(register, restartMarkerTable);
});
