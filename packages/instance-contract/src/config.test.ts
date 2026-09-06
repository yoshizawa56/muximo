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
  readMuximoConfigProfile,
  setMuximoConfigValue,
  writeMuximoConfig,
} from "./config.js";

type ConfigOperation = "missing" | "write" | "set" | "empty-agents" | "missing-web" | "invalid";
type ConfigFixture = { filePath: string };
type ConfigResult = {
  config: MuximoConfig | null;
  value: unknown;
  mode: number | null;
  webEnabled: boolean;
  webPort: number;
};
type ConfigContext = {
  enabled: string | null;
  defaultBackend: string | null;
  mode: number | null;
  webEnabled: boolean;
  webPort: number;
};

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
    name: "uses current defaults for omitted instance configuration fields",
    fixture: "missing-web" as const,
    input: "missing-web" as const,
    assert: [
      hasObserved<ConfigContext, ConfigResult>("webEnabled", false),
      hasObserved<ConfigContext, ConfigResult>("webPort", 5227),
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
    "missing-web": () => createFixture("missing-web"),
    invalid: () => createFixture("invalid"),
  },
  cases,
  execute: (fixture, operation) => {
    if (operation === "missing") {
      const config = readMuximoConfig(fixture.filePath);
      return createConfigResult(config, null, null);
    }
    if (operation === "missing-web") {
      const legacyConfig = Object.fromEntries(Object.entries(defaultMuximoConfig()).filter(([key]) => key !== "web"));
      writeFileSync(fixture.filePath, `${JSON.stringify(legacyConfig)}\n`);
      const config = readMuximoConfig(fixture.filePath);
      return createConfigResult(config, null, null);
    }
    if (operation === "invalid") return createConfigResult(readMuximoConfig(fixture.filePath), null, null);
    let config = defaultMuximoConfig();
    if (operation === "write") {
      config = setMuximoConfigValue(config, "agents.enabled", ["codex", "claude"]);
      config = setMuximoConfigValue(config, "agents.default", "claude");
      writeMuximoConfig(fixture.filePath, config);
      const saved = readMuximoConfig(fixture.filePath);
      return createConfigResult(saved, null, statSync(fixture.filePath).mode & 0o777);
    }
    if (operation === "empty-agents") {
      config = setMuximoConfigValue(config, "agents.enabled", ["codex"]);
      config = setMuximoConfigValue(config, "agents.default", "codex");
      config = setMuximoConfigValue(config, "agents.enabled", []);
      return createConfigResult(config, null, null);
    }
    config = setMuximoConfigValue(config, "agents.enabled", ["claude"]);
    return createConfigResult(config, getMuximoConfigValue(config, "agents.default"), null);
  },
  observe: (_fixture, result) =>
    result.ok
      ? {
          enabled: result.value.config?.agents.enabled.join(",") ?? null,
          defaultBackend: result.value.config?.agents.default ?? null,
          mode: result.value.mode,
          webEnabled: result.value.config?.web.proxy.enabled ?? false,
          webPort: result.value.config?.web.proxy.port ?? 0,
        }
      : { enabled: null, defaultBackend: null, mode: null, webEnabled: false, webPort: 0 },
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

function createConfigResult(config: MuximoConfig, value: unknown, mode: number | null): ConfigResult {
  return {
    config,
    value,
    mode,
    webEnabled: config.web.proxy.enabled,
    webPort: config.web.proxy.port,
  };
}

type ProfileOperation = "partial" | "full" | "unknown" | "invalid";
type ProfileFixture = { filePath: string };
type ProfileResult = {
  port: number;
  schemaMode: string;
  enabledAgents: string;
  tailscaleEnabled: boolean;
};
type ProfileContext = ProfileResult;

const profileCases = [
  {
    name: "fills omitted values from defaults while applying a partial profile",
    fixture: "partial" as const,
    input: "partial" as const,
    assert: [
      hasObserved<ProfileContext, ProfileResult>("port", 4318),
      hasObserved<ProfileContext, ProfileResult>("schemaMode", "push"),
      hasObserved<ProfileContext, ProfileResult>("enabledAgents", ""),
      hasObserved<ProfileContext, ProfileResult>("tailscaleEnabled", false),
    ],
  },
  {
    name: "accepts a complete configuration as an import profile",
    fixture: "full" as const,
    input: "full" as const,
    assert: [hasObserved<ProfileContext, ProfileResult>("port", 4317)],
  },
  {
    name: "rejects unknown profile keys",
    fixture: "unknown" as const,
    input: "unknown" as const,
    assert: [hasError<ProfileContext, ProfileResult>({ message: /invalid muximo config profile/ })],
  },
  {
    name: "rejects invalid profile values",
    fixture: "invalid" as const,
    input: "invalid" as const,
    assert: [hasError<ProfileContext, ProfileResult>({ message: /invalid muximo config profile/ })],
  },
] satisfies readonly OperationCase<ProfileOperation, ProfileOperation, ProfileResult, ProfileContext>[];

const profileTable: OperationTable<ProfileFixture, ProfileOperation, ProfileOperation, ProfileResult, ProfileContext> =
  {
    defaultFixture: () => createProfileFixture("partial"),
    fixtures: {
      partial: () => createProfileFixture("partial"),
      full: () => createProfileFixture("full"),
      unknown: () => createProfileFixture("unknown"),
      invalid: () => createProfileFixture("invalid"),
    },
    cases: profileCases,
    execute: (fixture) => {
      const config = readMuximoConfigProfile(fixture.filePath);
      return {
        port: config.daemon.port,
        schemaMode: config.database.schemaMode,
        enabledAgents: config.agents.enabled.join(","),
        tailscaleEnabled: config.serve.tailscale.enabled,
      };
    },
    observe: (_fixture, result) =>
      result.ok
        ? result.value
        : {
            port: 0,
            schemaMode: "",
            enabledAgents: "",
            tailscaleEnabled: false,
          },
  };

describe("muximo configuration profiles", () => {
  runOperationTable(it as unknown as TestRegistrar, profileTable);
});

function createFixture(kind?: "invalid" | "missing-web") {
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

function createProfileFixture(kind: "partial" | "full" | "unknown" | "invalid") {
  const root = mkdtempSync(join(tmpdir(), "muximo-config-profile-test-"));
  const filePath = join(root, "config.profile.json");
  const profile =
    kind === "partial"
      ? { version: 1, daemon: { port: 4318 }, database: { schemaMode: "push" } }
      : kind === "full"
        ? defaultMuximoConfig()
        : kind === "unknown"
          ? { version: 1, daemon: { unsupported: true } }
          : { version: 1, daemon: { port: 0 } };
  writeFileSync(filePath, `${JSON.stringify(profile)}\n`);
  return {
    fixture: { filePath },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
