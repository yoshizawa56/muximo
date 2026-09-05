import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { readMuximoConfig } from "@muximo/instance-contract";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createConfigHandler } from "./config.js";

class CaptureOutput extends Writable {
  public value = "";

  public _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error) => void): void {
    this.value += chunk.toString();
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
      hasObserved<ConfigContext, ConfigResult>("enabled", ""),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", null),
      hasObserved<ConfigContext, ConfigResult>("status", 0),
    ],
  },
  {
    name: "updates a configured provider through the non-interactive command",
    fixture: "default" as const,
    input: "set" as const,
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", "codex,claude"),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", null),
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
    const config = readMuximoConfig(fixture.filePath);
    return {
      output: output.value,
      enabled: config.agents.enabled.join(","),
      defaultBackend: config.agents.default,
      reportsAgentChange: output.value.includes("agents.enabled:  -> codex, claude"),
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

describe("muximo config CLI handler", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
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
