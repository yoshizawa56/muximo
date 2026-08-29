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
import type { DoctorReport, ServeRouteState, TailscaleServeResult } from "@muximo/infrastructure/cli-client";
import { type OperationCase, type OperationTable, runOperationTable, type TestRegistrar } from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import type { CliDaemonInput, CliDoctorInput, CliIo, CliServeInput } from "../commands/types.js";
import { createSystemHandlers } from "./system.js";

type SystemInput =
  | { kind: "doctor"; input: CliDoctorInput }
  | { kind: "daemon"; input: CliDaemonInput }
  | { kind: "serve"; input: CliServeInput };

type SystemResult = { status: number; out: string; err: string; calls: readonly string[] };
type SystemFixture = {
  out: string[];
  err: string[];
  calls: string[];
  handlers: ReturnType<typeof createSystemHandlers>;
};

function hasValue<Key extends keyof SystemResult>(name: string, key: Key, expected: SystemResult[Key]) {
  return { name, check: (context: SystemResult) => expect(context[key]).toEqual(expected) };
}

function containsText(name: string, key: "out" | "err", expected: string) {
  return { name, check: (context: SystemResult) => expect(context[key]).toContain(expected) };
}

function includesCall(name: string, expected: string) {
  return { name, check: (context: SystemResult) => expect(context.calls).toContain(expected) };
}

const daemonInputs: readonly CliDaemonInput[] = [
  { command: "start", foreground: false, refreshServers: false },
  { command: "status", foreground: false, refreshServers: false },
  { command: "stop", foreground: false, refreshServers: false },
  { command: "restart", foreground: false, refreshServers: true },
  { command: "ensure", foreground: false, refreshServers: false },
  { command: "log", foreground: false, refreshServers: false, lines: 20 },
];

const routeState: ServeRouteState = {
  schemaVersion: 1,
  environment: "local",
  component: "muximod",
  provider: "tailscale",
  hostname: "tail.example",
  publicUrl: "https://tail.example:8444/",
  localTarget: "http://127.0.0.1:4317",
  externalPort: 8444,
  path: "/",
  routeFingerprint: "fingerprint",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

const serveResult: TailscaleServeResult = {
  options: { provider: "tailscale", localPort: 4317, externalPort: 8444, tailscaleBinary: "tailscale" },
  route: {
    localPort: 4317,
    externalPort: 8444,
    hostname: routeState.hostname,
    localTarget: routeState.localTarget,
    publicUrl: routeState.publicUrl,
    routeFingerprint: routeState.routeFingerprint,
  },
  serveArgs: ["serve", "--bg"],
  hostname: "tail.example",
  url: routeState.publicUrl,
  localUrl: routeState.localTarget,
  stdout: "serve stdout\n",
  stderr: "serve stderr\n",
  statusJson: "{}",
};

const cases = [
  {
    name: "presents doctor diagnostics",
    input: { kind: "doctor", input: { verbose: true } },
    assert: [
      hasValue("presents a successful status", "status", 0),
      containsText("presents git", "out", "git: /usr/bin/git"),
    ] as const,
  },
  ...daemonInputs.map((input) => ({
    name: `dispatches daemon ${input.command}`,
    input: { kind: "daemon" as const, input },
    assert: [includesCall(`passes the daemon ${input.command}`, `daemon:${input.command}`)] as const,
  })),
  {
    name: "presents a configured serve route",
    input: {
      kind: "serve",
      input: { provider: "tailscale", command: "tailscale", localPort: 4317, externalPort: 8444 },
    },
    assert: [
      includesCall("passes the serve command", "serve:tailscale"),
      containsText("presents route", "out", "[muximo-cli] muximod Tailscale Serve"),
      containsText("presents provider errors", "err", "serve stderr"),
    ] as const,
  },
  {
    name: "presents serve status without controlling muximod",
    input: { kind: "serve", input: { provider: "tailscale", command: "status", localPort: 4317, externalPort: 8444 } },
    assert: [
      includesCall("passes serve status", "serve:status"),
      containsText("presents route status", "out", routeState.publicUrl),
    ] as const,
  },
  {
    name: "presents serve stop",
    input: { kind: "serve", input: { provider: "tailscale", command: "stop", localPort: 4317, externalPort: 8444 } },
    assert: [
      includesCall("passes serve stop", "serve:stop"),
      containsText("presents stop", "out", "Serve stopped"),
    ] as const,
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
          : await fixture.handlers.serve(input.input);
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
    controlSocket: "/tmp/muximod.sock",
    logFile: "/tmp/muximod.log",
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
      execute: async (): Promise<MuximodControlLogResult> => {
        calls.push("daemon:log");
        return { state: "available", logFile: "/tmp/muximod.log", lines: ["muximod log"] };
      },
    },
  };
  const handlers = createSystemHandlers({
    doctor: {
      execute: async (input) => {
        calls.push(`doctor:${input.verbose}`);
        return report;
      },
    },
    daemon: { defaults: daemonOptions, ...daemon },
    serve: {
      execute: async (input) => {
        calls.push(`serve:${input.command}`);
        if (input.command === "tailscale") return { command: "tailscale", result: serveResult, state: routeState };
        if (input.command === "status")
          return { command: "status", state: routeState, providerOutput: "route status\n" };
        return { command: "stop", state: "stopped", publicUrl: routeState.publicUrl };
      },
    },
    io,
  });
  return { out, err, calls, handlers };
}

describe("typed system CLI handlers", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
