import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { readMuximoConfig } from "@muximo/profile";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createConfigHandler } from "./config.js";

class CaptureOutput extends Writable {
  public value = "";

  public constructor(private readonly onPrompt?: () => void) {
    super();
  }

  public _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error) => void): void {
    const value = chunk.toString();
    this.value += value;
    if (value.endsWith(": ")) this.onPrompt?.();
    callback();
  }
}

type ConfigCommand = "path" | "show" | "set" | "init";
type ConfigFixture = { filePath: string };
type ConfigResult = {
  output: string;
  enabled: string;
  defaultBackend: string | null;
  reportsAgentChange: boolean;
  mentionsConfigPath: boolean;
  status: number;
};
type ConfigContext = {
  output: string;
  enabled: string;
  defaultBackend: string | null;
  reportsAgentChange: boolean;
  mentionsConfigPath: boolean;
  status: number;
};

const cases = [
  {
    name: "prints the resolved instance config path",
    fixture: "default" as const,
    input: "path" as const,
    assert: [hasObserved<ConfigContext, ConfigResult>("output", "config.json\n")],
  },
  {
    name: "prints the default config without starting the daemon",
    fixture: "default" as const,
    input: "show" as const,
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", "codex"),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", "codex"),
      hasObserved<ConfigContext, ConfigResult>("status", 0),
    ],
  },
  {
    name: "updates a configured provider through the non-interactive command",
    fixture: "default" as const,
    input: "set" as const,
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", "codex,claude"),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", "codex"),
      hasObserved<ConfigContext, ConfigResult>("reportsAgentChange", true),
      hasObserved<ConfigContext, ConfigResult>("mentionsConfigPath", false),
      hasObserved<ConfigContext, ConfigResult>("status", 0),
    ],
  },
  {
    name: "requires a terminal for interactive initialization",
    fixture: "default" as const,
    input: "init" as const,
    assert: [hasError<ConfigContext, ConfigResult>({ message: /requires an interactive terminal/ })],
  },
] satisfies readonly OperationCase<"default", ConfigCommand, ConfigResult, ConfigContext>[];

const table: OperationTable<ConfigFixture, "default", ConfigCommand, ConfigResult, ConfigContext> = {
  defaultFixture: () => createFixture(),
  fixtures: { default: () => createFixture() },
  cases,
  execute: async (fixture, command) => {
    const output = new CaptureOutput();
    const handler = createConfigHandler({
      filePath: fixture.filePath,
      input: Readable.from([]),
      output,
      isInteractive: false,
    });
    const input =
      command === "set" ? { command, key: "agents.enabled", values: ["codex,claude"] } : { command, values: [] };
    const status = await handler(input);
    return {
      output: output.value,
      enabled: readMuximoConfig(fixture.filePath).agents.enabled.join(","),
      defaultBackend: readMuximoConfig(fixture.filePath).agents.default,
      reportsAgentChange: output.value.includes('agents.enabled: ["codex"] -> ["codex","claude"]'),
      mentionsConfigPath: output.value.includes(fixture.filePath),
      status,
    };
  },
  observe: (fixture, result) =>
    result.ok
      ? {
          output: result.value.output.replace(fixture.filePath, "config.json"),
          enabled: result.value.enabled,
          defaultBackend: result.value.defaultBackend,
          reportsAgentChange: result.value.reportsAgentChange,
          mentionsConfigPath: result.value.mentionsConfigPath,
          status: result.value.status,
        }
      : {
          output: "",
          enabled: "",
          defaultBackend: null,
          reportsAgentChange: false,
          mentionsConfigPath: false,
          status: 1,
        },
};

type InitFixtureKey = "default";
type InitResult = { output: string; enabled: string; defaultBackend: string | null; status: number };
type InitContext = {
  enabled: string;
  defaultBackend: string | null;
  status: number;
  askedForTailscaleDetails: boolean;
  askedForAgentDetails: boolean;
  reportedInvalidEnabled: boolean;
  reportedInvalidDefault: boolean;
};

const initCases = [
  {
    name: "asks one required value per simple section and skips disabled Tailscale details",
    fixture: "default" as const,
    steps: ["\n", "\n", "no\n", "no\n", "no\n"],
    assert: [
      hasObserved<InitContext, InitResult>("status", 0),
      hasObserved<InitContext, InitResult>("enabled", "codex"),
      hasObserved<InitContext, InitResult>("defaultBackend", "codex"),
      hasObserved<InitContext, InitResult>("askedForTailscaleDetails", false),
      hasObserved<InitContext, InitResult>("askedForAgentDetails", false),
    ],
  },
  {
    name: "repeats invalid agent values and configures only enabled backends",
    fixture: "default" as const,
    steps: ["\n", "codex,invalid\n", "codex,claude\n", "yes\n", "opencode\n", "claude\n", "\n", "\n", "no\n", "no\n"],
    assert: [
      hasObserved<InitContext, InitResult>("status", 0),
      hasObserved<InitContext, InitResult>("enabled", "codex,claude"),
      hasObserved<InitContext, InitResult>("defaultBackend", "claude"),
      hasObserved<InitContext, InitResult>("askedForTailscaleDetails", false),
      hasObserved<InitContext, InitResult>("askedForAgentDetails", true),
      hasObserved<InitContext, InitResult>("reportedInvalidEnabled", true),
      hasObserved<InitContext, InitResult>("reportedInvalidDefault", true),
    ],
  },
  {
    name: "requires at least one enabled agent backend",
    fixture: "default" as const,
    steps: ["\n", "[]\n", "codex\n", "no\n", "no\n", "no\n"],
    assert: [
      hasObserved<InitContext, InitResult>("status", 0),
      hasObserved<InitContext, InitResult>("enabled", "codex"),
      hasObserved<InitContext, InitResult>("defaultBackend", "codex"),
      hasObserved<InitContext, InitResult>("askedForAgentDetails", false),
      hasObserved<InitContext, InitResult>("reportedInvalidEnabled", true),
    ],
  },
] satisfies readonly ScenarioCase<InitFixtureKey, string, InitResult, InitContext>[];

const initTable: ScenarioTable<ConfigFixture, InitFixtureKey, string, InitResult, InitContext> = {
  defaultFixture: () => createFixture(),
  fixtures: { default: () => createFixture() },
  cases: initCases,
  execute: async (fixture, steps) => {
    const input = new PassThrough();
    const remainingSteps = [...steps];
    const output = new CaptureOutput(() => {
      const step = remainingSteps.shift();
      if (step !== undefined) queueMicrotask(() => input.write(step));
    });
    const handler = createConfigHandler({
      filePath: fixture.filePath,
      input,
      output,
      isInteractive: true,
    });
    const statusPromise = handler({ command: "init", values: [] });
    const status = await statusPromise;
    input.end();
    const config = readMuximoConfig(fixture.filePath);
    return {
      output: output.value,
      enabled: config.agents.enabled.join(","),
      defaultBackend: config.agents.default,
      status,
    };
  },
  observe: (_fixture, result) =>
    result.ok
      ? {
          enabled: result.value.enabled,
          defaultBackend: result.value.defaultBackend,
          status: result.value.status,
          askedForTailscaleDetails: result.value.output.includes("Tailscale executable"),
          askedForAgentDetails: result.value.output.includes("Default agent backend"),
          reportedInvalidEnabled: result.value.output.includes("Invalid value for agents.enabled"),
          reportedInvalidDefault: result.value.output.includes("Invalid value for agents.default"),
        }
      : {
          enabled: "",
          defaultBackend: null,
          status: 1,
          askedForTailscaleDetails: false,
          askedForAgentDetails: false,
          reportedInvalidEnabled: false,
          reportedInvalidDefault: false,
        },
};

describe("muximo config CLI handler", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
  runScenarioTable(it as unknown as TestRegistrar, initTable);
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "muximo-cli-config-test-"));
  const directory = join(root, "instance");
  mkdirSync(directory, { recursive: true });
  return {
    fixture: { filePath: join(directory, "config.json") },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
