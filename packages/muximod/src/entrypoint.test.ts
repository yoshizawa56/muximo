import { defaultMuximoConfig, type MuximoConfig, setMuximoConfigValue } from "@muximo/profile";
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
};
type StartupContext = StartupResult;

const baseOptions: MuximodLaunchOptions = {
  schemaMode: "migrate",
  config: {
    host: "127.0.0.1",
    port: 4317,
    instanceDirectory: "/home/test/.local/state/muximo/muximod",
    configFile: "/home/test/.local/state/muximo/muximod/config.json",
    hookOutputDirectory: "/home/test/.local/state/muximo/muximod/hooks",
    pidFile: "/home/test/.local/state/muximo/muximod/muximod.pid",
    controlSocket: "/home/test/.local/state/muximo/muximod/muximod.sock",
    allowedOrigins: [],
    allowedRoots: ["/home/test"],
    logLevel: "info",
    logFile: "/home/test/.local/state/muximo/muximod/muximod.log",
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
    ],
  },
  {
    name: "keeps explicit environment values above instance settings",
    input: "ambient-overrides" as const,
    assert: [
      hasObserved<StartupContext, StartupResult>("enabled", "codex,claude"),
      hasObserved<StartupContext, StartupResult>("allowedRoots", ["/environment/root"]),
      hasObserved<StartupContext, StartupResult>("claudeBinary", "/environment/claude"),
      hasObserved<StartupContext, StartupResult>("tailscaleBinary", "/environment/tailscale"),
      hasObserved<StartupContext, StartupResult>("tailscaleArgs", ["--socket", "/environment/socket"]),
      hasObserved<StartupContext, StartupResult>("tailscaleHostname", "environment.example"),
      hasObserved<StartupContext, StartupResult>("tailscalePort", 9443),
      hasObserved<StartupContext, StartupResult>("tailscalePath", "/environment"),
    ],
  },
  {
    name: "preserves the static workspace policy when the instance has no roots",
    input: "empty-instance" as const,
    assert: [
      hasObserved<StartupContext, StartupResult>("enabled", "codex"),
      hasObserved<StartupContext, StartupResult>("defaultBackend", "codex"),
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
    const instanceConfig = input === "empty-instance" ? defaultMuximoConfig("linux") : configuredConfig;
    const options =
      input === "ambient-overrides"
        ? {
            ...baseOptions,
            config: {
              ...baseOptions.config,
              allowedRoots: ["/environment/root"],
              runtimeEnvironment: {
                ...baseOptions.config.runtimeEnvironment,
                tailscaleBinary: "/environment/tailscale",
                claudeBinary: "/environment/claude",
              },
            },
          }
        : baseOptions;
    const environment =
      input === "ambient-overrides"
        ? {
            HOME: "/home/test",
            MUXIMOD_WORKSPACE_ROOTS: "/environment/root",
            MUXIMO_TAILSCALE_ARGS: '["--socket", "/environment/socket"]',
            MUXIMO_TAILSCALE_HOSTNAME: "environment.example",
            MUXIMO_TAILSCALE_PATH: "/environment",
          }
        : { HOME: "/home/test" };
    const result = resolveMuximodStartupConfiguration(options, instanceConfig, environment);
    return {
      enabled: result.config.enabledAgentBackends?.join(",") ?? "",
      defaultBackend: result.config.defaultAgentBackend ?? null,
      allowedRoots: result.config.allowedRoots,
      claudeBinary: result.environment.MUXIMO_CLAUDE_BIN ?? null,
      tailscaleBinary: result.hostSettings.tailscale.executable,
      tailscaleArgs: result.hostSettings.tailscale.args,
      tailscaleHostname: result.hostSettings.tailscale.hostname,
      tailscalePort: result.hostSettings.tailscale.externalPort,
      tailscalePath: result.hostSettings.tailscale.path,
    };
  },
  observe: (_fixture, result) => (result.ok ? result.value : emptyResult()),
};

describe("muximod startup configuration", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createConfiguredConfig(): MuximoConfig {
  let config = defaultMuximoConfig("linux");
  config = setMuximoConfigValue(config, "agents.enabled", ["codex", "claude"]);
  config = setMuximoConfigValue(config, "agents.default", "claude");
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
  };
}
