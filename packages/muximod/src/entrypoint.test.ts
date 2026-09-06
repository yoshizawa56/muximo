import { defaultMuximoConfig, type MuximoConfig, setMuximoConfigValue } from "@muximo/instance-contract";
import {
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { resolveMuximodStartupConfiguration } from "./entrypoint.js";
import type { MuximodLaunchOptions } from "./launch.js";

type StartupInput = "configured" | "ambient-overrides" | "empty-instance";
type StartupResult = {
  enabled: string;
  defaultBackend: string | null;
  allowedRoots: readonly string[];
  claudeBinary: string | null;
  tailscaleBinary: string;
  tailscaleArgs: readonly string[];
  tailscaleHostname: string | null;
  tailscalePort: number;
  tailscalePath: string;
  codexRemote: string;
  opencodeServerUrl: string | null;
};
type StartupContext = StartupResult;

const baseOptions: MuximodLaunchOptions = {
  instanceDirectory: "/home/test/.local/state/muximo",
  workingDirectory: "/workspace/project",
  runtimeEnvironment: {
    homeDirectory: "/home/test",
    path: "/usr/bin",
    codexHome: null,
    claudeConfigDirectory: null,
    tailscaleBinary: null,
    tmuxPane: null,
    tmuxSocket: null,
    worktreeId: null,
    worktreeRoot: null,
    muximoCommand: null,
    codexRemote: "unix://",
    codexBinary: null,
    claudeBinary: null,
    opencodeBinary: null,
    migrationsDirectory: null,
  },
};

const configuredConfig = createConfiguredConfig();
const cases = [
  {
    name: "loads agent, workspace, executable, and Tailscale settings in the daemon",
    input: "configured" as const,
    assert: [
      hasObserved<StartupContext, StartupResult>("enabled", "codex,claude"),
      hasObserved<StartupContext, StartupResult>("defaultBackend", "claude"),
      hasObserved<StartupContext, StartupResult>("allowedRoots", ["/workspace/project/work"]),
      hasObserved<StartupContext, StartupResult>("claudeBinary", "/home/test/bin/claude"),
      hasObserved<StartupContext, StartupResult>("tailscaleBinary", "/home/test/bin/tailscale"),
      hasObserved<StartupContext, StartupResult>("tailscaleArgs", ["--socket", "/tmp/tailscaled.sock"]),
      hasObserved<StartupContext, StartupResult>("tailscaleHostname", "machine.example"),
      hasObserved<StartupContext, StartupResult>("tailscalePort", 9443),
      hasObserved<StartupContext, StartupResult>("tailscalePath", "/muximo"),
      hasObserved<StartupContext, StartupResult>("codexRemote", "unix:///custom"),
      hasObserved<StartupContext, StartupResult>("opencodeServerUrl", "http://127.0.0.1:4096"),
    ],
  },
  {
    name: "ignores ambient values that duplicate instance configuration",
    input: "ambient-overrides" as const,
    assert: [
      hasObserved<StartupContext, StartupResult>("enabled", "codex,claude"),
      hasObserved<StartupContext, StartupResult>("allowedRoots", ["/workspace/project/work"]),
      hasObserved<StartupContext, StartupResult>("claudeBinary", "/home/test/bin/claude"),
      hasObserved<StartupContext, StartupResult>("tailscaleBinary", "/home/test/bin/tailscale"),
      hasObserved<StartupContext, StartupResult>("tailscaleArgs", ["--socket", "/tmp/tailscaled.sock"]),
      hasObserved<StartupContext, StartupResult>("tailscaleHostname", "machine.example"),
      hasObserved<StartupContext, StartupResult>("tailscalePort", 9443),
      hasObserved<StartupContext, StartupResult>("tailscalePath", "/muximo"),
    ],
  },
  {
    name: "uses the home directory as the workspace boundary when no roots are configured",
    input: "empty-instance" as const,
    assert: [
      hasObserved<StartupContext, StartupResult>("enabled", ""),
      hasObserved<StartupContext, StartupResult>("defaultBackend", null),
      hasObserved<StartupContext, StartupResult>("allowedRoots", ["/home/test"]),
      hasObserved<StartupContext, StartupResult>("tailscaleBinary", "tailscale"),
      hasObserved<StartupContext, StartupResult>("tailscaleArgs", []),
      hasObserved<StartupContext, StartupResult>("tailscaleHostname", null),
      hasObserved<StartupContext, StartupResult>("tailscalePort", 8444),
      hasObserved<StartupContext, StartupResult>("tailscalePath", "/"),
    ],
  },
] satisfies readonly OperationCase<"default", StartupInput, StartupResult, StartupContext>[];

const table: OperationTable<undefined, "default", StartupInput, StartupResult, StartupContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => {
    const instanceConfig = input === "empty-instance" ? defaultMuximoConfig() : configuredConfig;
    const environment =
      input === "ambient-overrides"
        ? {
            HOME: "/home/test",
            MUXIMOD_WORKSPACE_ROOTS: "/environment/root",
            MUXIMO_TAILSCALE_ARGS: '["--socket", "/environment/socket"]',
            MUXIMO_TAILSCALE_HOSTNAME: "environment.example",
            MUXIMO_TAILSCALE_PATH: "/environment",
            MUXIMO_CLAUDE_BIN: "/environment/claude",
            TAILSCALE_BIN: "/environment/tailscale",
            MUXIMO_CODEX_REMOTE: "https://environment-codex",
            MUXIMO_OPENCODE_SERVER_URL: "http://127.0.0.1:4999",
          }
        : { HOME: "/home/test" };
    const result = resolveMuximodStartupConfiguration(baseOptions, instanceConfig, environment);
    return {
      enabled: result.config.enabledAgentBackends.join(","),
      defaultBackend: result.config.defaultAgentBackend,
      allowedRoots: result.config.allowedRoots,
      claudeBinary: result.environment.MUXIMO_CLAUDE_BIN ?? null,
      tailscaleBinary: result.hostSettings.tailscale.executable,
      tailscaleArgs: result.hostSettings.tailscale.args,
      tailscaleHostname: result.hostSettings.tailscale.hostname,
      tailscalePort: result.hostSettings.tailscale.externalPort,
      tailscalePath: result.hostSettings.tailscale.path,
      codexRemote: result.config.runtimeEnvironment.codexRemote,
      opencodeServerUrl: result.config.opencodeServerUrl ?? null,
    };
  },
  observe: (_fixture, result) => (result.ok ? result.value : emptyResult()),
};

describe("muximod startup configuration", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createConfiguredConfig(): MuximoConfig {
  let config = defaultMuximoConfig();
  config = setMuximoConfigValue(config, "agents.enabled", ["codex", "claude"]);
  config = setMuximoConfigValue(config, "agents.default", "claude");
  config = setMuximoConfigValue(config, "agents.codexRemote", "unix:///custom");
  config = setMuximoConfigValue(config, "agents.opencode.serverUrl", "http://127.0.0.1:4096");
  config = setMuximoConfigValue(config, "agents.executables.claude", "~/bin/claude");
  config = setMuximoConfigValue(config, "workspace.roots", ["work"]);
  config = setMuximoConfigValue(config, "serve.tailscale.enabled", true);
  config = setMuximoConfigValue(config, "serve.tailscale.executable", "~/bin/tailscale");
  config = setMuximoConfigValue(config, "serve.tailscale.args", ["--socket", "/tmp/tailscaled.sock"]);
  config = setMuximoConfigValue(config, "serve.tailscale.hostname", "machine.example");
  config = setMuximoConfigValue(config, "serve.tailscale.externalPort", 9443);
  return setMuximoConfigValue(config, "serve.tailscale.path", "/muximo");
}

function emptyResult(): StartupResult {
  return {
    enabled: "",
    defaultBackend: null,
    allowedRoots: [],
    claudeBinary: null,
    tailscaleBinary: "",
    tailscaleArgs: [],
    tailscaleHostname: null,
    tailscalePort: 0,
    tailscalePath: "",
    codexRemote: "",
    opencodeServerUrl: null,
  };
}
