import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  defaultMuximoConfig,
  diffMuximoConfig,
  getMuximoConfigValue,
  type MuximoConfig,
  readMuximoConfig,
  setMuximoConfigValue,
  writeMuximoConfig,
} from "./config.js";

type ConfigOperation = "missing" | "write" | "set" | "empty-agents" | "invalid";
type ConfigFixture = { filePath: string };
type ConfigResult = { config: MuximoConfig | null; value: unknown; mode: number | null };
type ConfigContext = { enabled: string | null; defaultBackend: string | null; mode: number | null };

const cases = [
  {
    name: "returns the safe default without creating an instance file",
    fixture: "missing" as const,
    input: "missing" as const,
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", ""),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", null),
      hasObserved<ConfigContext, ConfigResult>("mode", null),
    ],
  },
  {
    name: "writes a private atomic instance configuration",
    fixture: "write" as const,
    input: "write" as const,
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", "codex,claude"),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", "claude"),
      hasObserved<ConfigContext, ConfigResult>("mode", 0o600),
    ],
  },
  {
    name: "updates a value while preserving the configuration invariant",
    fixture: "set" as const,
    input: "set" as const,
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", "claude"),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", null),
    ],
  },
  {
    name: "allows an empty enabled agent list for tmux-only instances",
    fixture: "empty-agents" as const,
    input: "empty-agents" as const,
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", ""),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", null),
    ],
  },
  {
    name: "rejects unsupported configuration shapes",
    fixture: "invalid" as const,
    input: "invalid" as const,
    assert: [hasError<ConfigContext, ConfigResult>({ message: /invalid muximo config/ })],
  },
] satisfies readonly OperationCase<ConfigOperation, ConfigOperation, ConfigResult, ConfigContext>[];

const table: OperationTable<ConfigFixture, ConfigOperation, ConfigOperation, ConfigResult, ConfigContext> = {
  defaultFixture: () => createFixture(),
  fixtures: {
    missing: () => createFixture(),
    write: () => createFixture(),
    set: () => createFixture(),
    "empty-agents": () => createFixture(),
    invalid: () => createFixture("invalid"),
  },
  cases,
  execute: (fixture, operation) => {
    if (operation === "missing") {
      const config = readMuximoConfig(fixture.filePath);
      return { config, value: null, mode: null };
    }
    if (operation === "invalid") return { config: readMuximoConfig(fixture.filePath), value: null, mode: null };
    let config = defaultMuximoConfig();
    if (operation === "write") {
      config = setMuximoConfigValue(config, "agents.enabled", ["codex", "claude"]);
      config = setMuximoConfigValue(config, "agents.default", "claude");
      writeMuximoConfig(fixture.filePath, config);
      const saved = readMuximoConfig(fixture.filePath);
      return { config: saved, value: null, mode: statSync(fixture.filePath).mode & 0o777 };
    }
    if (operation === "empty-agents") {
      config = setMuximoConfigValue(config, "agents.enabled", ["codex"]);
      config = setMuximoConfigValue(config, "agents.default", "codex");
      config = setMuximoConfigValue(config, "agents.enabled", []);
      return { config, value: null, mode: null };
    }
    config = setMuximoConfigValue(config, "agents.enabled", ["claude"]);
    return { config, value: getMuximoConfigValue(config, "agents.default"), mode: null };
  },
  observe: (_fixture, result) =>
    result.ok
      ? {
          enabled: result.value.config?.agents.enabled.join(",") ?? null,
          defaultBackend: result.value.config?.agents.default ?? null,
          mode: result.value.mode,
        }
      : { enabled: null, defaultBackend: null, mode: null },
};

type DefaultResult = { executable: string; changedKeys: readonly string[]; agentDefault: string | null };
type DefaultContext = { executable: string; changedKeys: readonly string[]; agentDefault: string | null };

const defaultCases = [
  {
    name: "uses platform-neutral Tailscale and disabled agents by default",
    input: "default" as const,
    assert: [
      hasObserved<DefaultContext, DefaultResult>("executable", "tailscale"),
      hasObserved<DefaultContext, DefaultResult>("agentDefault", null),
      hasObserved<DefaultContext, DefaultResult>("changedKeys", ["agents.enabled"]),
    ],
  },
] satisfies readonly OperationCase<"default", "default", DefaultResult, DefaultContext>[];

const defaultTable: OperationTable<undefined, "default", "default", DefaultResult, DefaultContext> = {
  defaultFixture: noFixture(),
  cases: defaultCases,
  execute: () => {
    const before = defaultMuximoConfig();
    const after = setMuximoConfigValue(before, "agents.enabled", ["codex", "claude"]);
    return {
      executable: before.serve.tailscale.executable,
      agentDefault: before.agents.default,
      changedKeys: diffMuximoConfig(before, after).map((change) => change.key),
    };
  },
  observe: (_fixture, result) => (result.ok ? result.value : { executable: "", changedKeys: [], agentDefault: null }),
};

describe("muximo instance configuration", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
  runOperationTable(it as unknown as TestRegistrar, defaultTable);
});

function createFixture(kind?: "invalid") {
  const root = mkdtempSync(join(tmpdir(), "muximo-config-test-"));
  const directory = join(root, "instance");
  mkdirSync(directory, { recursive: true });
  const filePath = join(directory, "config.json");
  if (kind === "invalid") writeFileSync(filePath, `${JSON.stringify({ version: 1, legacy: true })}\n`);
  return {
    fixture: { filePath },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
