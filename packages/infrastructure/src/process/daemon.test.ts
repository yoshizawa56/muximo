import type { DaemonOptions, ProcessResult } from "@muximo/application";
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
import { buildMuximodDaemonEnvironment, MuximodDaemonProcess } from "./daemon.js";

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

describe("muximod process adapter", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, environmentTable);
  runOperationTable(register, processTable);
});
