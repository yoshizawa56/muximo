import {
  hasError,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import {
  buildServeArgs,
  buildServeHttpUrl,
  buildServeUrl,
  buildTailscaleInvocation,
  parseTailscaleHostname,
  type TailscaleInvocation,
  type TailscaleServeConfig,
} from "./index.js";

type EmptyContext = {};

type InvocationExpectation = {
  command: string;
  invocationArgs: readonly string[];
  path: string;
  cliMode: string;
};

type InvocationInput = {
  binary: string;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  executablePaths: readonly string[];
  expected: InvocationExpectation;
};

const invocationCases = [
  {
    name: "keeps a missing named command as a direct invocation",
    input: {
      binary: "tailscale",
      args: ["serve", "--set-path=/agent's", "http://127.0.0.1:4317"],
      environment: { HOME: "/Users/tester", PATH: "/usr/bin", SHELL: "/bin/zsh" },
      platform: "darwin",
      executablePaths: [],
      expected: {
        command: "tailscale",
        invocationArgs: ["serve", "--set-path=/agent's", "http://127.0.0.1:4317"],
        path: "/usr/bin",
        cliMode: "1",
      },
    },
    assert: [
      {
        name: "matches the direct invocation",
        check: (_ctx: EmptyContext, result) => {
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          assertInvocation(result.value, invocationCases[0]!.input.expected);
        },
      },
    ],
  },
  {
    name: "keeps an explicit executable path direct",
    input: {
      binary: "/opt/tailscale/Tailscale",
      args: ["status", "--json"],
      environment: { PATH: "/usr/bin", TAILSCALE_BE_CLI: "0" },
      platform: "darwin",
      executablePaths: [],
      expected: {
        command: "/opt/tailscale/Tailscale",
        invocationArgs: ["status", "--json"],
        path: "/usr/bin",
        cliMode: "0",
      },
    },
    assert: [
      {
        name: "keeps the explicit executable invocation direct",
        check: (_ctx: EmptyContext, result) => {
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          assertInvocation(result.value, invocationCases[1]!.input.expected);
        },
      },
    ],
  },
  {
    name: "keeps a PATH executable direct",
    input: {
      binary: "tailscale",
      args: ["serve", "--bg"],
      environment: { PATH: "/usr/bin" },
      platform: "darwin",
      executablePaths: ["/usr/bin/tailscale"],
      expected: {
        command: "tailscale",
        invocationArgs: ["serve", "--bg"],
        path: "/usr/bin",
        cliMode: "1",
      },
    },
    assert: [
      {
        name: "keeps the PATH executable invocation direct",
        check: (_ctx: EmptyContext, result) => {
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          assertInvocation(result.value, invocationCases[2]!.input.expected);
        },
      },
    ],
  },
  {
    name: "uses the bundled macOS CLI when it is not on PATH",
    input: {
      binary: "tailscale",
      args: ["status", "--json"],
      environment: { HOME: "/Users/tester", PATH: "/usr/bin", SHELL: "/bin/zsh" },
      platform: "darwin",
      executablePaths: ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"],
      expected: {
        command: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        invocationArgs: ["status", "--json"],
        path: "/usr/bin",
        cliMode: "1",
      },
    },
    assert: [
      {
        name: "uses the bundled executable directly",
        check: (_ctx: EmptyContext, result) => {
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          assertInvocation(result.value, invocationCases[3]!.input.expected);
        },
      },
    ],
  },
  {
    name: "keeps a missing command direct for synchronous daemon lookups",
    input: {
      binary: "tailscale",
      args: ["ip", "-4"],
      environment: { PATH: "/usr/bin", SHELL: "/bin/zsh" },
      platform: "darwin",
      executablePaths: [],
      expected: {
        command: "tailscale",
        invocationArgs: ["ip", "-4"],
        path: "/usr/bin",
        cliMode: "1",
      },
    },
    assert: [
      {
        name: "returns a direct invocation when the command is unavailable",
        check: (_ctx: EmptyContext, result) => {
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          assertInvocation(result.value, invocationCases[4]!.input.expected);
        },
      },
    ],
  },
] satisfies readonly OperationCase<"default", InvocationInput, TailscaleInvocation, EmptyContext>[];

const invocationTable: OperationTable<undefined, "default", InvocationInput, TailscaleInvocation, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: invocationCases,
  execute: (_fixture, input) =>
    buildTailscaleInvocation(input.binary, [...input.args], input.environment, input.platform, {
      isExecutable: (path) => input.executablePaths.includes(path),
    }),
  observe: () => ({}),
};

function assertInvocation(actual: TailscaleInvocation, expected: InvocationExpectation): void {
  expect(actual.command).toBe(expected.command);
  expect(actual.args).toEqual(expected.invocationArgs);
  expect(actual.environment.PATH).toBe(expected.path);
  expect(actual.environment.TAILSCALE_BE_CLI).toBe(expected.cliMode);
}

const argsCases = [
  {
    name: "builds a persistent HTTPS command",
    input: { localPort: 4317, externalPort: 443 },
    assert: [returns<EmptyContext, string[]>(["serve", "--bg", "--https=443", "--yes", "http://127.0.0.1:4317"])],
  },
  {
    name: "builds a command for a custom external port",
    input: { localPort: 1, externalPort: 8449 },
    assert: [returns<EmptyContext, string[]>(["serve", "--bg", "--https=8449", "--yes", "http://127.0.0.1:1"])],
  },
  {
    name: "builds a path-mounted command",
    input: { localPort: 4317, externalPort: 443, path: "muximod" },
    assert: [
      returns<EmptyContext, string[]>([
        "serve",
        "--bg",
        "--https=443",
        "--yes",
        "--set-path=/muximod",
        "http://127.0.0.1:4317",
      ]),
    ],
  },
] satisfies readonly OperationCase<"default", TailscaleServeConfig, string[], EmptyContext>[];

const argsTable: OperationTable<undefined, "default", TailscaleServeConfig, string[], EmptyContext> = {
  defaultFixture: noFixture(),
  cases: argsCases,
  execute: (_fixture, input) => buildServeArgs(input),
  observe: () => ({}),
};

type UrlInput =
  | { kind: "http"; hostname: string; port: number }
  | { kind: "websocket"; hostname: string; path: string }
  | { kind: "invalid"; hostname: string };
const urlCases = [
  {
    name: "builds a websocket URL",
    input: { hostname: "host.tailnet.ts.net", path: "agent", kind: "websocket" },
    assert: [returns<EmptyContext, string>("wss://host.tailnet.ts.net/agent")],
  },
  {
    name: "builds HTTPS without a port for 443",
    input: { hostname: "host.tailnet.ts.net", port: 443, kind: "http" },
    assert: [returns<EmptyContext, string>("https://host.tailnet.ts.net/")],
  },
  {
    name: "includes a non-default HTTPS port",
    input: { hostname: "host.tailnet.ts.net", port: 8449, kind: "http" },
    assert: [returns<EmptyContext, string>("https://host.tailnet.ts.net:8449/")],
  },
  {
    name: "rejects credentials in a Tailscale hostname",
    input: { hostname: "https://user:password@host.tailnet.ts.net", kind: "invalid" },
    assert: [hasError<EmptyContext, string>({ message: "Tailscale Serve hostname must not contain credentials" })],
  },
] satisfies readonly OperationCase<"default", UrlInput, string, EmptyContext>[];

const urlTable: OperationTable<undefined, "default", UrlInput, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: urlCases,
  execute: (_fixture, input) => {
    if (input.kind === "http") return buildServeHttpUrl(input.hostname, input.port);
    if (input.kind === "websocket") return buildServeUrl(input.hostname, input.path);
    return buildServeHttpUrl(input.hostname, 443);
  },
  observe: () => ({}),
};

const hostnameCases = [
  {
    name: "reads and normalizes the current DNS name",
    input: JSON.stringify({ Self: { DNSName: "host.tailnet.ts.net." } }),
    assert: [returns<EmptyContext, string | undefined>("host.tailnet.ts.net")],
  },
  {
    name: "returns undefined for malformed status JSON",
    input: "not json",
    assert: [returns<EmptyContext, string | undefined>(undefined)],
  },
] satisfies readonly OperationCase<"default", string, string | undefined, EmptyContext>[];

const hostnameTable: OperationTable<undefined, "default", string, string | undefined, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: hostnameCases,
  execute: (_fixture, input) => parseTailscaleHostname(input),
  observe: () => ({}),
};

type InvalidInput = { kind: "local" | "external"; localPort: number; externalPort: number };
const invalidCases = [
  {
    name: "rejects an invalid local port",
    input: { kind: "local", localPort: 65_536, externalPort: 443 },
    assert: [hasError<EmptyContext, string[]>({ message: /^Invalid Tailscale Serve port/ })],
  },
  {
    name: "rejects an invalid external port",
    input: { kind: "external", localPort: 4317, externalPort: 65_536 },
    assert: [hasError<EmptyContext, string[]>({ message: /^Invalid Tailscale Serve external port/ })],
  },
] satisfies readonly OperationCase<"default", InvalidInput, string[], EmptyContext>[];

const invalidTable: OperationTable<undefined, "default", InvalidInput, string[], EmptyContext> = {
  defaultFixture: noFixture(),
  cases: invalidCases,
  execute: (_fixture, input) => buildServeArgs({ localPort: input.localPort, externalPort: input.externalPort }),
  observe: () => ({}),
};

describe("tailscale serve adapter", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, invocationTable);
  runOperationTable(register, argsTable);
  runOperationTable(register, urlTable);
  runOperationTable(register, hostnameTable);
  runOperationTable(register, invalidTable);
});
