import type {
  DaemonEnsureResult,
  DaemonOptions,
  DaemonRestartResult,
  DaemonStartResult,
  DaemonStatusResult,
  DaemonStopResult,
  StartDaemonInput,
} from "@muximo/application";
import type { MuximodControlLogResult } from "@muximo/contract/control";
import type { DoctorReport, TailscaleServeResult } from "@muximo/infrastructure/cli-client";
import {
  type Assertion,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import type { CliDaemonInput, CliDevInput, CliDoctorInput, CliIo, CliServeInput } from "../commands/types.js";
import { createSystemHandlers } from "./system.js";

type SystemInput =
  | { kind: "doctor"; input: CliDoctorInput }
  | { kind: "daemon"; input: CliDaemonInput }
  | { kind: "serve"; input: CliServeInput }
  | { kind: "dev"; input: CliDevInput };

type SystemResult = {
  status: number;
  out: string;
  err: string;
  calls: readonly string[];
};

type SystemFixture = {
  out: string[];
  err: string[];
  calls: string[];
  handlers: ReturnType<typeof createSystemHandlers>;
};

const contains = (name: string, key: keyof SystemResult, value: string): Assertion<SystemResult, SystemResult> => ({
  name,
  check: (context) => expect(context[key]).toContain(value),
});

const called = (name: string, value: string): Assertion<SystemResult, SystemResult> => ({
  name,
  check: (context) => expect(context.calls).toContain(value),
});

const daemonInputs: readonly CliDaemonInput[] = [
  { command: "start", foreground: false, refreshServers: false, host: "127.0.0.1", port: 4317 },
  { command: "status", foreground: false, refreshServers: false, host: "127.0.0.1", port: 4317 },
  { command: "stop", foreground: false, refreshServers: false, host: "127.0.0.1", port: 4317 },
  { command: "restart", foreground: false, refreshServers: true, host: "127.0.0.1", port: 4317 },
  { command: "ensure", foreground: false, refreshServers: false, host: "127.0.0.1", port: 4317 },
  {
    command: "log",
    foreground: false,
    refreshServers: false,
    host: "127.0.0.1",
    port: 4317,
    lines: 20,
  },
];

const cases = [
  {
    name: "maps typed doctor input and presents the diagnostic report",
    input: { kind: "doctor", input: { verbose: true } },
    assert: [
      called("passes the verbose doctor input", "doctor:true"),
      contains("presents doctor command diagnostics", "out", "git: /usr/bin/git"),
      contains("presents verbose doctor details", "out", "codex remote: unix://"),
    ],
  },
  ...daemonInputs.map((input) => ({
    name: `maps daemon ${input.command} input to the focused use case`,
    input: { kind: "daemon" as const, input },
    assert: [
      called(`passes the daemon ${input.command} input`, `daemon:${input.command}`),
      contains(`presents the daemon ${input.command} result`, "out", "muximod"),
    ] as const,
  })),
  {
    name: "maps typed serve input and presents structured serve data",
    input: {
      kind: "serve",
      input: {
        provider: "tailscale",
        foreground: false,
        muximodHost: "127.0.0.1",
        muximodPort: 4317,
        externalPort: 8444,
        logLevel: "info",
      },
    },
    assert: [
      called("passes the serve input", "serve:tailscale"),
      contains("presents serve summary", "out", "muximo serve tailscale: https://tail.example"),
      contains("presents serve stdout", "out", "serve stdout"),
      contains("presents serve stderr", "err", "serve stderr"),
    ],
  },
  {
    name: "cleans up a foreground serve lease after the daemon exits",
    input: {
      kind: "serve",
      input: {
        provider: "tailscale",
        foreground: true,
        muximodHost: "127.0.0.1",
        muximodPort: 4317,
        externalPort: 8444,
        logLevel: "info",
      },
    },
    assert: [
      called("waits for the foreground daemon", "serve:foreground-wait"),
      called("cleans up the foreground daemon lease", "serve:cleanup"),
    ],
  },
  {
    name: "maps typed dev input and preserves its process status",
    input: { kind: "dev", input: { serveProvider: "tailscale" } },
    assert: [
      called("passes the dev input", "dev:tailscale"),
      {
        name: "returns the development process status",
        check: (context: SystemResult) => expect(context.status).toBe(7),
      },
    ],
  },
] satisfies readonly OperationCase<"default", SystemInput, SystemResult, SystemResult>[];

const table: OperationTable<SystemFixture, "default", SystemInput, SystemResult, SystemResult> = {
  defaultFixture: () => ({ fixture: createFixture() }),
  cases,
  execute: async (fixture, input) => {
    const status =
      input.kind === "doctor"
        ? await fixture.handlers.doctor(input.input)
        : input.kind === "daemon"
          ? await fixture.handlers.daemon(input.input)
          : input.kind === "serve"
            ? await fixture.handlers.serve(input.input)
            : await fixture.handlers.dev(input.input);
    return { status, out: fixture.out.join(""), err: fixture.err.join(""), calls: [...fixture.calls] };
  },
  observe: (fixture, result) => ({
    status: result.ok ? result.value.status : -1,
    out: fixture.out.join(""),
    err: fixture.err.join(""),
    calls: [...fixture.calls],
  }),
};

function createFixture(): SystemFixture {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[] = [];
  const io = {
    out: { write: (value: string) => out.push(value) },
    err: { write: (value: string) => err.push(value) },
  } as unknown as CliIo;
  const report: DoctorReport = {
    status: 0,
    commands: [{ command: "git", path: "/usr/bin/git", required: true }],
    codexProfile: { profile: null, state: "not-configured" },
    mise: { path: "/usr/bin/mise" },
    details: {
      defaultRemote: "unix://",
      worktreeRootPattern: "<workspace-parent>/<workspace-name>.worktrees/<session-name>",
    },
  };
  const daemonOptions: DaemonOptions = {
    host: "127.0.0.1",
    port: 4317,
    pidFile: "/tmp/muximod.pid",
  };
  const daemon = {
    start: {
      execute: async (input: StartDaemonInput): Promise<DaemonStartResult> => {
        calls.push("daemon:start");
        return { kind: "background", result: { state: "started", host: input.options.host, port: input.options.port } };
      },
    },
    status: {
      execute: async (input: DaemonOptions): Promise<DaemonStatusResult> => {
        calls.push("daemon:status");
        return { state: "running", host: input.host, port: input.port };
      },
    },
    stop: {
      execute: async (): Promise<DaemonStopResult> => {
        calls.push("daemon:stop");
        return { state: "stopped" };
      },
    },
    restart: {
      execute: async (input: DaemonOptions): Promise<DaemonRestartResult> => {
        calls.push("daemon:restart");
        return { state: "restarted", host: input.host, port: input.port };
      },
    },
    ensure: {
      execute: async (input: DaemonOptions): Promise<DaemonEnsureResult> => {
        calls.push("daemon:ensure");
        return { state: "started", host: input.host, port: input.port };
      },
    },
    log: {
      execute: async (_input: { lines: number }): Promise<MuximodControlLogResult> => {
        calls.push("daemon:log");
        return {
          state: "available",
          logFile: "/tmp/muximod.log",
          lines: ['{"service":"muximod","event":"daemon.started"}'],
        };
      },
    },
  };
  const serveResult: TailscaleServeResult = {
    options: {
      provider: "tailscale",
      foreground: false,
      muximodHost: "127.0.0.1",
      muximodPort: 4317,
      externalPort: 8444,
      logLevel: "info",
      tailscaleBinary: "tailscale",
    },
    serveArgs: ["serve"],
    hostname: "tail.example",
    url: "https://tail.example",
    localUrl: "http://127.0.0.1:4317",
    allowedOrigins: ["https://tail.example"],
    stdout: "serve stdout\n",
    stderr: "serve stderr\n",
  };
  const handlers = createSystemHandlers({
    doctor: {
      execute: async (input) => {
        calls.push(`doctor:${input.verbose}`);
        return report;
      },
    },
    daemon: {
      defaults: { pidFile: daemonOptions.pidFile, controlSocket: "/tmp/muximod.sock" },
      ...daemon,
    },
    serve: {
      execute: async (input) => {
        calls.push(`serve:${input.provider}`);
        if (!input.foreground) return serveResult;
        return {
          ...serveResult,
          foregroundProcess: {
            wait: async () => {
              calls.push("serve:foreground-wait");
              return { code: 0, interrupted: false };
            },
            terminate: () => calls.push("serve:foreground-terminate"),
          },
          cleanup: async () => {
            calls.push("serve:cleanup");
          },
        };
      },
    },
    dev: {
      execute: async (input: CliDevInput) => {
        calls.push(`dev:${input.serveProvider}`);
        return 7;
      },
    },
    io,
  });
  return { out, err, calls, handlers };
}

describe("typed system CLI handlers", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
