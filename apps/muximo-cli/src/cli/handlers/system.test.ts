import type {
  DaemonEnsureResult,
  DaemonOptions,
  DaemonRestartResult,
  DaemonStartResult,
  DaemonStatusResult,
  DaemonStopResult,
  StartDaemonInput,
} from "@muximo/application";
import { DaemonHealthError } from "@muximo/application";
import { protocolVersion } from "@muximo/contract/shared";
import type {
  DoctorReport,
  MuximodLogFileLine,
  ServeRouteState,
  TailscaleServeResult,
} from "@muximo/infrastructure/cli-client";
import { type OperationCase, type OperationTable, runOperationTable, type TestRegistrar } from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import type { CliDaemonInput, CliDoctorInput, CliIo, CliServeInput } from "../commands/types.js";
import type { DaemonLogRequest, DaemonLogResult } from "./system.js";
import { createSystemHandlers } from "./system.js";

type SystemInput =
  | { kind: "doctor"; input: CliDoctorInput }
  | { kind: "daemon"; input: CliDaemonInput }
  | { kind: "serve"; input: CliServeInput };

type SystemResult = { status: number; out: string; err: string; calls: readonly string[] };
type SystemFixtureKey =
  | "default"
  | "startup-failed"
  | "pid-unhealthy"
  | "config-changed"
  | "status-unavailable"
  | "serve-mismatch";
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

function excludesText(name: string, key: "out" | "err", expected: string) {
  return { name, check: (context: SystemResult) => expect(context[key]).not.toContain(expected) };
}

function includesCall(name: string, expected: string) {
  return { name, check: (context: SystemResult) => expect(context.calls).toContain(expected) };
}

const daemonInputs: readonly (CliDaemonInput & { caseSuffix?: string })[] = [
  { command: "start", refreshServers: false },
  { command: "status", refreshServers: false },
  { command: "stop", refreshServers: false },
  { command: "restart", refreshServers: true },
  { command: "ensure", refreshServers: false },
  { command: "log", refreshServers: false, lines: 20, json: false, follow: false },
  {
    command: "log",
    refreshServers: false,
    lines: 20,
    json: true,
    follow: false,
    filter: "server.started",
    caseSuffix: " with json output and a filter",
  },
];

const routeState: ServeRouteState = {
  schemaVersion: 1,
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
    name: `dispatches daemon ${input.command}${input.caseSuffix ?? ""}`,
    input: { kind: "daemon" as const, input },
    assert: [includesCall(`passes the daemon ${input.command}`, `daemon:${input.command}`)] as const,
  })),
  {
    name: "presents a configured serve route",
    input: {
      kind: "serve",
      input: { provider: "tailscale", command: "tailscale" },
    },
    assert: [
      includesCall("passes the serve command", "serve:tailscale"),
      containsText("presents route", "out", "[muximo-cli] muximod Tailscale Serve"),
      containsText("presents provider errors", "err", "serve stderr"),
    ] as const,
  },
  {
    name: "presents serve status without controlling muximod",
    input: { kind: "serve", input: { provider: "tailscale", command: "status" } },
    assert: [
      includesCall("passes serve status", "serve:status"),
      containsText("presents route status", "out", `public URL: ${routeState.publicUrl}`),
      containsText("presents the configured proxy target", "out", `proxy target: ${routeState.localTarget} (matches)`),
      excludesText("does not dump provider JSON", "out", "unrelated-provider-route"),
    ] as const,
  },
  {
    name: "reports when the live route does not match the active configuration",
    fixture: "serve-mismatch" as const,
    input: { kind: "serve", input: { provider: "tailscale", command: "status" } },
    assert: [
      hasValue("returns a failure status", "status", 1),
      containsText("presents the configured external port", "out", "external port: 8445 (not found)"),
      containsText(
        "presents the configured proxy target",
        "out",
        "proxy target: http://127.0.0.1:4317 (does not match)",
      ),
      containsText("reports the route mismatch", "err", "live Tailscale Serve route does not match"),
    ] as const,
  },
  {
    name: "presents serve stop",
    input: { kind: "serve", input: { provider: "tailscale", command: "stop" } },
    assert: [
      includesCall("passes serve stop", "serve:stop"),
      containsText("presents stop", "out", "Serve stopped"),
    ] as const,
  },
] satisfies readonly OperationCase<SystemFixtureKey, SystemInput, SystemResult, SystemResult>[];

const logPresentationCases = [
  {
    name: "renders daemon log lines in the human format",
    input: { kind: "daemon", input: { command: "log", refreshServers: false, lines: 20, json: false, follow: false } },
    assert: [
      hasValue("returns a successful status", "status", 0),
      containsText("renders the log level and service", "out", "INFO [muximod]"),
      containsText("renders the event and message", "out", "server.started muximod log"),
      excludesText("does not print raw JSON", "out", '"event":"server.started"'),
    ],
  },
  {
    name: "renders daemon log lines as raw JSON with --json",
    input: {
      kind: "daemon",
      input: { command: "log", refreshServers: false, lines: 20, json: true, follow: false, filter: "server.started" },
    },
    assert: [
      hasValue("returns a successful status", "status", 0),
      containsText("prints the raw JSON line", "out", '"event":"server.started"'),
      excludesText("does not render the human format", "out", "INFO [muximod]"),
    ],
  },
  {
    name: "streams followed daemon log lines once",
    input: { kind: "daemon", input: { command: "log", refreshServers: false, lines: 20, json: false, follow: true } },
    assert: [
      hasValue("returns a successful status", "status", 0),
      containsText("streams the log line once", "out", "server.started muximod log"),
      {
        name: "does not reprint followed lines through the presenter",
        check: (context: SystemResult) => expect(context.out.split("server.started muximod log").length - 1).toBe(1),
      },
    ],
  },
] as const;

const startupFailureCase = {
  name: "presents a daemon startup exit with its log path",
  fixture: "startup-failed" as const,
  input: { kind: "daemon", input: { command: "start", refreshServers: false } },
  assert: [
    hasValue("returns a failure status", "status", 1),
    containsText("presents the startup exit", "err", "muximod exited during startup with exit code 1"),
    containsText("presents the startup diagnostic", "err", "configuration could not be loaded"),
    containsText("presents the daemon log path", "err", "muximod log: /tmp/muximod.log"),
  ] as const,
} satisfies OperationCase<SystemFixtureKey, SystemInput, SystemResult, SystemResult>;

const pidUnhealthyCase = {
  name: "recommends restarting a daemon that does not match the selected instance",
  fixture: "pid-unhealthy" as const,
  input: { kind: "daemon", input: { command: "ensure", refreshServers: false } },
  assert: [
    hasValue("returns a failure status", "status", 1),
    containsText("presents the process ownership failure", "err", "is not owned by the selected instance"),
    containsText("recommends applying the selected configuration", "err", 'run "muximo daemon restart"'),
  ] as const,
} satisfies OperationCase<SystemFixtureKey, SystemInput, SystemResult, SystemResult>;

const configChangedCase = {
  name: "shows a restart recommendation for changed daemon configuration",
  fixture: "config-changed" as const,
  input: { kind: "daemon", input: { command: "status", refreshServers: false } },
  assert: [
    hasValue("returns a successful status", "status", 0),
    containsText("reports the daemon version separately", "out", "daemon version: 0.1.0"),
    containsText("reports the client version separately", "out", "client version: 0.1.0"),
    containsText("reports the changed keys", "out", "daemon.port, serve.tailscale.enabled"),
    containsText("recommends a restart", "out", "muximo daemon restart"),
  ] as const,
} satisfies OperationCase<SystemFixtureKey, SystemInput, SystemResult, SystemResult>;

const statusUnavailableCase = {
  name: "keeps daemon status usable when configuration diagnostics are unavailable",
  fixture: "status-unavailable" as const,
  input: { kind: "daemon", input: { command: "status", refreshServers: false } },
  assert: [
    hasValue("returns a successful status", "status", 0),
    containsText("reports the daemon as running", "out", "muximod running"),
    containsText("explains unavailable diagnostics", "out", "configuration status is unavailable"),
  ] as const,
} satisfies OperationCase<SystemFixtureKey, SystemInput, SystemResult, SystemResult>;

const allCases = [
  ...cases,
  ...logPresentationCases,
  startupFailureCase,
  pidUnhealthyCase,
  configChangedCase,
  statusUnavailableCase,
] as const;

const table: OperationTable<SystemFixture, SystemFixtureKey, SystemInput, SystemResult, SystemResult> = {
  defaultFixture: () => ({ fixture: createFixture("default") }),
  fixtures: {
    default: () => ({ fixture: createFixture("default") }),
    "startup-failed": () => ({ fixture: createFixture("startup-failed") }),
    "pid-unhealthy": () => ({ fixture: createFixture("pid-unhealthy") }),
    "config-changed": () => ({ fixture: createFixture("config-changed") }),
    "status-unavailable": () => ({ fixture: createFixture("status-unavailable") }),
    "serve-mismatch": () => ({ fixture: createFixture("serve-mismatch") }),
  },
  cases: allCases,
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

function createFixture(key: SystemFixtureKey): SystemFixture {
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
    pidFile: "/tmp/muximod.pid",
    controlSocket: "/tmp/muximod.sock",
    logFile: "/tmp/muximod.log",
  };
  const daemon = {
    start: {
      execute: async (_input: StartDaemonInput): Promise<DaemonStartResult> => {
        calls.push("daemon:start");
        if (key === "startup-failed") {
          throw new DaemonHealthError(
            "startup_failed",
            { logFile: "/tmp/muximod.log" },
            {
              startedAt: 0,
              pid: 402,
              process: {
                started: false,
                code: 1,
                interrupted: false,
                signal: null,
                failureDiagnostic: "configuration could not be loaded",
              },
            },
          );
        }
        return { kind: "background", result: { state: "started", host: "127.0.0.1", port: 4317 } };
      },
    },
    status: {
      execute: async (_input: DaemonOptions): Promise<DaemonStatusResult> => {
        calls.push("daemon:status");
        return { state: "running", host: "127.0.0.1", port: 4317 };
      },
    },
    stop: {
      execute: async (): Promise<DaemonStopResult> => {
        calls.push("daemon:stop");
        return { state: "stopped" };
      },
    },
    restart: {
      execute: async (_input: DaemonOptions): Promise<DaemonRestartResult> => {
        calls.push("daemon:restart");
        return { state: "restarted", host: "127.0.0.1", port: 4317 };
      },
    },
    ensure: {
      execute: async (_input: DaemonOptions): Promise<DaemonEnsureResult> => {
        calls.push("daemon:ensure");
        if (key === "pid-unhealthy") {
          throw new DaemonHealthError("pid_unhealthy", { logFile: "/tmp/muximod.log" }, { startedAt: 0, pid: 402 });
        }
        return { state: "started", host: "127.0.0.1", port: 4317 };
      },
    },
    readStatus: {
      execute: async (): Promise<import("@muximo/contract/control").MuximodDaemonStatus> => {
        if (key === "status-unavailable") throw new Error("configuration status unavailable");
        return {
          protocolVersion,
          daemonVersion: "0.1.0",
          configuration:
            key === "config-changed"
              ? { state: "restart_recommended", changedKeys: ["daemon.port", "serve.tailscale.enabled"] }
              : { state: "current", changedKeys: [] },
        };
      },
    },
    log: {
      execute: async (request: DaemonLogRequest): Promise<DaemonLogResult> => {
        calls.push("daemon:log");
        const lines: readonly MuximodLogFileLine[] = [
          {
            raw: '{"timestamp":"2026-08-30T00:00:00.000Z","level":"info","service":"muximod","pid":402,"processInstanceId":"instance","mode":"background","event":"server.started","context":{},"fields":{"message":"muximod log"}}',
            record: {
              timestamp: "2026-08-30T00:00:00.000Z",
              level: "info",
              service: "muximod",
              pid: 402,
              processInstanceId: "instance",
              mode: "background",
              event: "server.started",
              context: {},
              fields: { message: "muximod log" },
            },
          },
        ];
        request.onLines?.(lines);
        return { state: "available", logFile: "/tmp/muximod.log", lines, followed: request.follow };
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
    clientVersion: "0.1.0",
    serve: {
      execute: async (input) => {
        calls.push(`serve:${input.command}`);
        if (input.command === "tailscale") return { command: "tailscale", result: serveResult, state: routeState };
        if (input.command === "status") {
          const mismatch = key === "serve-mismatch";
          return {
            command: "status",
            state: routeState,
            expectedExternalPort: mismatch ? 8445 : routeState.externalPort,
            expectedLocalTarget: routeState.localTarget,
            expectedPath: routeState.path,
            expectedPublicUrl: mismatch ? "https://tail.example:8445/" : routeState.publicUrl,
            stateMatchesConfiguration: !mismatch,
            liveRoute: mismatch
              ? { endpointAvailable: false, pathAvailable: false, proxyTargetMatches: false }
              : { endpointAvailable: true, pathAvailable: true, proxyTargetMatches: true },
          };
        }
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
