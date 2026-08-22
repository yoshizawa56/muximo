import { describe, expect, it } from "vitest";
import {
  hasError,
  hasObserved,
  noFixture,
  returns,
  runOperationTable,
  type Assertion,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { parseServeOptions, runServeCommand, type ServeCommandOptions } from "./serve-command.js";

type EmptyContext = {};
const matchesOptions = (expected: Partial<ServeCommandOptions>): Assertion<EmptyContext, ServeCommandOptions> => ({
  name: "returns the configured Serve options",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject(expected);
  },
});

type ParseInput = { args: string[]; environment: NodeJS.ProcessEnv };
const parseCases = [
  {
    name: "uses a muximod-only Serve profile by default",
    input: { args: ["tailscale"], environment: { MUXIMOD_PORT: "4391", MUXIMO_SERVE_PORT: "8444", TAILSCALE_BIN: "tailscale-test" } },
    assert: [matchesOptions({ provider: "tailscale", muximodHost: "127.0.0.1", muximodPort: 4391, externalPort: 8444, tailscaleBinary: "tailscale-test" })],
  },
  {
    name: "parses the managed muximod logging options",
    input: { args: ["tailscale", "--log-level", "debug", "--log-file", "/private/tmp/muximo-serve.log"], environment: {} },
    assert: [matchesOptions({ logLevel: "debug", logFile: "/private/tmp/muximo-serve.log" })],
  },
  {
    name: "rejects a provider that is not implemented yet",
    input: { args: ["cloudflare"], environment: {} },
    assert: [hasError<EmptyContext, ServeCommandOptions>({ message: "unsupported serve provider: cloudflare" })],
  },
] satisfies readonly OperationCase<"default", ParseInput, ServeCommandOptions, EmptyContext>[];

const parseTable: OperationTable<undefined, "default", ParseInput, ServeCommandOptions, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: parseCases,
  execute: (_fixture, input) => parseServeOptions(input.args, input.environment),
  observe: () => ({}),
};

type RunFixture = {
  ensured: unknown[];
  calls: Array<{ command: string; args: string[] }>;
  output: string;
  error: string;
};
type RunContext = { ensured: readonly unknown[]; calls: readonly { command: string; args: string[] }[]; summary: string; error: string; helpBackground: boolean; helpBgFlag: boolean };
type RunInput = { args: string[]; environment: NodeJS.ProcessEnv };

const runFixture = (): FixtureHandle<RunFixture> => ({
  fixture: { ensured: [], calls: [], output: "", error: "" },
});

const runCases = [
  {
    name: "ensures muximod and upserts the fixed Tailscale endpoint",
    input: { args: ["tailscale", "--port", "443"], environment: { MUXIMOD_PORT: "4391", MUXIMO_TAILSCALE_HOSTNAME: "muximo-host.tailnet.ts.net" } },
    assert: [
      returns<RunContext, number>(0),
      hasObserved<RunContext, number>("ensured", [expect.objectContaining({ muximodPort: 4391, externalPort: 443 })]),
      hasObserved<RunContext, number>("calls", [{ command: "tailscale", args: ["serve", "--bg", "--https=443", "--yes", "http://127.0.0.1:4391"] }]),
      hasObserved<RunContext, number>("summary", "muximo serve tailscale: https://muximo-host.tailnet.ts.net/ -> http://127.0.0.1:4391"),
    ],
  },
  {
    name: "documents automatic background startup in help",
    input: { args: ["tailscale", "--help"], environment: {} },
    assert: [returns<RunContext, number>(0), hasObserved<RunContext, number>("ensured", []), hasObserved<RunContext, number>("calls", []), hasObserved<RunContext, number>("helpBackground", true), hasObserved<RunContext, number>("helpBgFlag", true)],
  },
] satisfies readonly OperationCase<"default", RunInput, number, RunContext>[];

const runTable: OperationTable<RunFixture, "default", RunInput, number, RunContext> = {
  defaultFixture: runFixture,
  cases: runCases,
  execute: async (fixture, input) => runServeCommand(input.args, {
    ensureMuximod: async (options) => { fixture.ensured.push({ ...options }); },
    runCommand: async (command, args) => {
      fixture.calls.push({ command, args });
      return { stdout: "", stderr: "" };
    },
    out: (value) => { fixture.output += value; },
    err: (value) => { fixture.error += value; },
  }, input.environment),
  observe: (fixture) => ({
    ensured: [...fixture.ensured],
    calls: [...fixture.calls],
    summary: fixture.output.trim(),
    error: fixture.error,
    helpBackground: fixture.output.includes("Ensures muximod is running in the background"),
    helpBgFlag: fixture.output.includes("Tailscale Serve with --bg"),
  }),
};

describe("muximo serve command", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, parseTable);
  runOperationTable(register, runTable);
});
