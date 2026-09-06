import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  type CliOptionResolution,
  defineOptions,
  readOptionValues,
  registerOptions,
  resolveOptionValues,
  scanRootOptions,
} from "./index.js";

const optionSpecs = defineOptions(
  {
    key: "port",
    flags: ["--port <port>"],
    description: "Port",
    exposure: "both",
    environment: {
      name: "MUXIMO_PORT",
      description: "Port",
      decode: (value: string) => Number(value),
    },
    defaultValue: 4317,
  },
  {
    key: "force",
    flags: ["--force", "--no-force"],
    description: "Force",
    exposure: "both",
    environment: {
      name: "MUXIMO_FORCE",
      description: "Force",
      decode: (value: string) => value === "1",
    },
    defaultValue: false,
  },
  {
    key: "deepSetting",
    description: "A setting intended for environment-only configuration.",
    exposure: "environment",
    environment: {
      name: "MUXIMO_DEEP_SETTING",
      description: "Environment-only setting.",
    },
  },
);

type Input = {
  raw: Record<string, unknown>;
  args: readonly string[];
  environment: NodeJS.ProcessEnv;
};

const cases = [
  {
    name: "prefers an explicit CLI value over its environment value",
    input: {
      raw: { port: "6000" },
      args: ["--port", "6000"],
      environment: { MUXIMO_PORT: "5000" },
    },
    assert: [
      returns<CliOptionResolution, CliOptionResolution>({
        values: { port: "6000", force: false },
        sources: { port: "cli", force: "default" },
      }),
    ],
  },
  {
    name: "uses and decodes an environment value when the CLI is silent",
    input: { raw: {}, args: [], environment: { MUXIMO_PORT: "5000", MUXIMO_FORCE: "1" } },
    assert: [
      returns<CliOptionResolution, CliOptionResolution>({
        values: { port: 5000, force: true },
        sources: { port: "environment", force: "environment" },
      }),
    ],
  },
  {
    name: "uses a declared default when neither source is present",
    input: { raw: {}, args: [], environment: {} },
    assert: [
      returns<CliOptionResolution, CliOptionResolution>({
        values: { port: 4317, force: false },
        sources: { port: "default", force: "default" },
      }),
    ],
  },
  {
    name: "keeps an explicit negative flag ahead of a truthy environment value",
    input: {
      raw: { force: false },
      args: ["--no-force"],
      environment: { MUXIMO_FORCE: "1" },
    },
    assert: [
      returns<CliOptionResolution, CliOptionResolution>({
        values: { port: 4317, force: false },
        sources: { port: "default", force: "cli" },
      }),
    ],
  },
  {
    name: "allows a deep option to be environment-only",
    input: { raw: {}, args: [], environment: { MUXIMO_DEEP_SETTING: "enabled" } },
    assert: [
      returns<CliOptionResolution, CliOptionResolution>({
        values: { port: 4317, force: false, deepSetting: "enabled" },
        sources: { port: "default", force: "default", deepSetting: "environment" },
      }),
    ],
  },
] satisfies readonly OperationCase<"default", Input, CliOptionResolution, CliOptionResolution>[];

const table: OperationTable<undefined, "default", Input, CliOptionResolution, CliOptionResolution> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => resolveOptionValues(input.raw, optionSpecs, input),
  observe: (_fixture, result) => (result.ok ? result.value : { values: {}, sources: {} }),
};

describe("CLI option resolution", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
});

type BootstrapInput = { args: readonly string[] };
type BootstrapResult = ReturnType<typeof scanRootOptions> & { values: Record<string, unknown> };
type BootstrapContext = BootstrapResult;

const bootstrapOptionSpecs = defineOptions(...optionSpecs, {
  key: "target",
  flags: ["--target <name>"],
  description: "Target",
  exposure: "both",
  environment: { name: "MUXIMO_TARGET", description: "Target" },
});

const bootstrapCases = [
  {
    name: "keeps required global option values out of the command position",
    input: { args: ["--port", "5000", "--force", "run"] },
    assert: [
      returns<BootstrapContext, BootstrapResult>({
        options: ["--port", "5000", "--force"],
        commandIndex: 3,
        values: { port: "5000", force: true },
      }),
    ],
  },
  {
    name: "supports an inline target option before a command",
    input: { args: ["--port=5000", "--target=dev", "daemon", "start"] },
    assert: [
      returns<BootstrapContext, BootstrapResult>({
        options: ["--port=5000", "--target=dev"],
        commandIndex: 2,
        values: { port: "5000", target: "dev" },
      }),
    ],
  },
  {
    name: "does not treat command arguments as root options",
    input: { args: ["run", "--port", "5000"] },
    assert: [
      returns<BootstrapContext, BootstrapResult>({
        options: [],
        commandIndex: 0,
        values: {},
      }),
    ],
  },
] satisfies readonly OperationCase<"default", BootstrapInput, BootstrapResult, BootstrapContext>[];

const bootstrapTable: OperationTable<undefined, "default", BootstrapInput, BootstrapResult, BootstrapContext> = {
  defaultFixture: noFixture(),
  cases: bootstrapCases,
  execute: (_fixture, input) => {
    const scan = scanRootOptions(input.args, bootstrapOptionSpecs);
    return { ...scan, values: readOptionValues(scan.options, bootstrapOptionSpecs) };
  },
  observe: (_fixture, result) => (result.ok ? result.value : { options: [], commandIndex: -1, values: {} }),
};

describe("CLI root option bootstrap", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, bootstrapTable);
});

const helpOptionSpecs = defineOptions(
  {
    key: "port",
    flags: ["--port <port>"],
    description: "Port.",
    exposure: "both",
    environment: { name: "MUXIMO_PORT", description: "Port." },
  },
  {
    key: "worktree",
    flags: ["--worktree [name]", "--no-worktree"],
    description: "Run the session in a managed worktree.",
    flagDescriptions: { "--no-worktree": "Run the session in the current workspace." },
    exposure: "cli",
  },
);

type HelpInput = Record<string, never>;
type HelpContext = { help: string };

const containsHelpText = (value: string) => ({
  name: `contains help text: ${value}`,
  check: (context: HelpContext) => {
    expect(context.help).toContain(value);
  },
});

const excludesHelpText = (value: string) => ({
  name: `excludes help text: ${value}`,
  check: (context: HelpContext) => {
    expect(context.help).not.toContain(value);
  },
});

const helpCases = [
  {
    name: "uses the flag-specific description for a negated option",
    input: {},
    assert: [containsHelpText("--no-worktree"), containsHelpText("Run the session in the current workspace.")],
  },
  {
    name: "does not repeat an environment description that matches the option description",
    input: {},
    assert: [containsHelpText("Environment: MUXIMO_PORT"), excludesHelpText("Environment: MUXIMO_PORT — Port.")],
  },
] satisfies readonly OperationCase<"default", HelpInput, string, HelpContext>[];

const helpTable: OperationTable<undefined, "default", HelpInput, string, HelpContext> = {
  defaultFixture: noFixture(),
  cases: helpCases,
  execute: () => {
    const command = new Command().name("muximo");
    registerOptions(command, helpOptionSpecs);
    return command.helpInformation();
  },
  observe: (_fixture, result) => ({ help: result.ok ? result.value : "" }),
};

describe("CLI option help metadata", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, helpTable);
});
