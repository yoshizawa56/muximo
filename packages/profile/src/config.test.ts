import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  hasObserved,
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

type ConfigOperation = "missing" | "write" | "set" | "invalid";
type ConfigFixture = { filePath: string };
type ConfigResult = { config: MuximoConfig | null; value: unknown; mode: number | null };
type ConfigContext = { enabled: string | null; defaultBackend: string | null; mode: number | null };

const cases = [
  {
    name: "returns the safe default without creating an instance file",
    fixture: "missing",
    input: "missing",
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", "codex"),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", "codex"),
      hasObserved<ConfigContext, ConfigResult>("mode", null),
    ],
  },
  {
    name: "writes a private atomic instance configuration",
    fixture: "write",
    input: "write",
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", "codex,claude"),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", "claude"),
      hasObserved<ConfigContext, ConfigResult>("mode", 0o600),
    ],
  },
  {
    name: "updates a value while preserving the configuration invariant",
    fixture: "set",
    input: "set",
    assert: [
      hasObserved<ConfigContext, ConfigResult>("enabled", "claude"),
      hasObserved<ConfigContext, ConfigResult>("defaultBackend", null),
    ],
  },
  {
    name: "rejects unsupported configuration shapes",
    fixture: "invalid",
    input: "invalid",
    assert: [hasError<ConfigContext, ConfigResult>({ message: /invalid muximo config/ })],
  },
] satisfies readonly OperationCase<ConfigOperation, ConfigOperation, ConfigResult, ConfigContext>[];

const table: OperationTable<ConfigFixture, ConfigOperation, ConfigOperation, ConfigResult, ConfigContext> = {
  defaultFixture: () => createFixture(),
  fixtures: {
    missing: () => createFixture(),
    write: () => createFixture(),
    set: () => createFixture(),
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

type DefaultsOperation = "darwin" | "linux";
type DefaultsResult = { executable: string; changedKeys: readonly string[] };
type DefaultsContext = { executable: string; changedKeys: readonly string[] };

const defaultsCases = [
  {
    name: "uses the macOS application bundle Tailscale executable by default",
    fixture: "darwin" as const,
    input: "darwin" as const,
    assert: [
      hasObserved<DefaultsContext, DefaultsResult>(
        "executable",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
      ),
      hasObserved<DefaultsContext, DefaultsResult>("changedKeys", ["agents.enabled"]),
    ],
  },
  {
    name: "uses PATH lookup for Tailscale on non-macOS platforms",
    fixture: "linux" as const,
    input: "linux" as const,
    assert: [
      hasObserved<DefaultsContext, DefaultsResult>("executable", "tailscale"),
      hasObserved<DefaultsContext, DefaultsResult>("changedKeys", ["agents.enabled"]),
    ],
  },
] satisfies readonly OperationCase<DefaultsOperation, DefaultsOperation, DefaultsResult, DefaultsContext>[];

const defaultsTable: OperationTable<
  ConfigFixture,
  DefaultsOperation,
  DefaultsOperation,
  DefaultsResult,
  DefaultsContext
> = {
  defaultFixture: () => createFixture(),
  fixtures: {
    darwin: () => createFixture(),
    linux: () => createFixture(),
  },
  cases: defaultsCases,
  execute: (_fixture, platform) => {
    const before = defaultMuximoConfig(platform);
    const after = setMuximoConfigValue(before, "agents.enabled", ["codex", "claude"]);
    return {
      executable: before.serve.tailscale.executable,
      changedKeys: diffMuximoConfig(before, after).map((change) => change.key),
    };
  },
  observe: (_fixture, result) => (result.ok ? result.value : { executable: "", changedKeys: [] }),
};

describe("muximo instance configuration", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
  runOperationTable(it as unknown as TestRegistrar, defaultsTable);
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
