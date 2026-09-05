import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import {
  defaultMuximoConfig,
  readMuximoConfig,
  setMuximoConfigValue,
  writeMuximoConfig,
} from "@muximo/instance-contract";
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

type ConfigCommand = "path" | "show" | "set" | "import" | "init";
type ConfigFixtureKind = "default" | "import";
type ConfigFixture = { filePath: string; sourcePath: string };
type ConfigResult = {
  output: string;
  enabled: string;
  defaultBackend: string | null;
  port: number;
  reportsAgentChange: boolean;
  mentionsConfigPath: boolean;
  status: number;
};
type ConfigContext = {
  output: string;
  enabled: string;
  defaultBackend: string | null;
  port: number;
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
  {
    name: "replaces the instance with defaults plus an imported profile",
    fixture: "import" as const,
    input: "import" as const,
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", ""),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", null),
      hasObserved<ConfigContext, ConfigResult>("port", 4318),
      hasObserved<ConfigContext, ConfigResult>("reportsAgentChange", true),
      hasObserved<ConfigContext, ConfigResult>("status", 0),
    ],
  },
] satisfies readonly OperationCase<ConfigFixtureKind, ConfigCommand, ConfigResult, ConfigContext>[];

const table: OperationTable<ConfigFixture, ConfigFixtureKind, ConfigCommand, ConfigResult, ConfigContext> = {
  defaultFixture: () => createFixture(),
  fixtures: { default: () => createFixture(), import: () => createFixture("import") },
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
      command === "set"
        ? { command, key: "agents.enabled", values: ["codex,claude"] }
        : command === "import"
          ? { command, source: fixture.sourcePath, values: [] }
          : { command, values: [] };
    const status = await handler(input);
    const config = readMuximoConfig(fixture.filePath);
    return {
      output: output.value,
      enabled: config.agents.enabled.join(","),
      defaultBackend: config.agents.default,
      port: config.daemon.port,
      reportsAgentChange: output.value.includes("agents.enabled:"),
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
          port: result.value.port,
          reportsAgentChange: result.value.reportsAgentChange,
          mentionsConfigPath: result.value.mentionsConfigPath,
          status: result.value.status,
        }
      : {
          output: "",
          enabled: "",
          defaultBackend: null,
          port: 0,
          reportsAgentChange: false,
          mentionsConfigPath: false,
          status: 1,
        },
};

describe("muximo config CLI handler", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFixture(kind?: "import") {
  const root = mkdtempSync(join(tmpdir(), "muximo-cli-config-test-"));
  const directory = join(root, "instance");
  mkdirSync(directory, { recursive: true });
  const sourcePath = join(root, "config.profile.json");
  if (kind === "import") {
    let current = defaultMuximoConfig();
    current = setMuximoConfigValue(current, "daemon.port", 4320);
    current = setMuximoConfigValue(current, "agents.enabled", ["codex"]);
    writeMuximoConfig(join(directory, "config.json"), current);
    writeFileSync(sourcePath, `${JSON.stringify({ version: 1, daemon: { port: 4318 } })}\n`);
  }
  return {
    fixture: { filePath: join(directory, "config.json"), sourcePath },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
