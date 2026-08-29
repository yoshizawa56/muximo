import type { DaemonOptions } from "@muximo/application";
import type { MuximodConfig } from "@muximo/muximod/client";
import {
  hasError,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createMuximodConfigResolver } from "./muximod-config.js";

type ConfigInput = { environment: NodeJS.ProcessEnv; workingDirectory: string; daemon: DaemonOptions };
type ConfigContext = {};

const runtimeEnvironment = {
  homeDirectory: "/home/test",
  path: null,
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
};

const cases = [
  {
    name: "derives every daemon-owned path from the instance directory",
    input: {
      environment: { HOME: "/home/test" },
      workingDirectory: "/workspace/project",
      daemon: { host: "127.0.0.1", port: 4317, pidFile: "/ignored/pid" },
    },
    assert: [
      returns<ConfigContext, MuximodConfig>({
        host: "127.0.0.1",
        port: 4317,
        instanceDirectory: "/home/test/.local/state/muximo",
        hookOutputDirectory: "/home/test/.local/state/muximo/hooks",
        pidFile: "/home/test/.local/state/muximo/muximod.pid",
        controlSocket: "/home/test/.local/state/muximo/muximod.sock",
        allowedOrigins: [],
        allowedRoots: ["/workspace/project"],
        logLevel: "info",
        logFile: "/home/test/.local/state/muximo/muximod.log",
        workingDirectory: "/workspace/project",
        runtimeEnvironment,
      }),
    ],
  },
  {
    name: "normalizes the selected instance and host runtime values",
    input: {
      environment: {
        HOME: "/home/test",
        MUXIMOD_INSTANCE_DIR: "state",
        MUXIMOD_TMUX_SOCKET: "run/tmux.sock",
        MUXIMOD_MUXIMO_COMMAND: "/opt/muximo",
        MUXIMO_CODEX_REMOTE: "https://codex.example",
        MUXIMO_CODEX_BIN: "/opt/bin/codex",
        MUXIMOD_MIGRATIONS_DIR: "migrations",
        MUXIMOD_WORKSPACE_ROOTS: "./workspaces:/tmp/shared",
        MUXIMO_LOG_FILE: "logs/muximod.log",
        MUXIMO_LOG_LEVEL: "debug",
        MUXIMOD_ALLOWED_ORIGINS: "https://web.example/,http://127.0.0.1:5227/",
      },
      workingDirectory: "/workspace/project",
      daemon: { host: "127.0.0.1", port: 4317, pidFile: "/ignored/pid" },
    },
    assert: [
      returns<ConfigContext, MuximodConfig>({
        host: "127.0.0.1",
        port: 4317,
        instanceDirectory: "/workspace/project/state",
        hookOutputDirectory: "/workspace/project/state/hooks",
        pidFile: "/workspace/project/state/muximod.pid",
        controlSocket: "/workspace/project/state/muximod.sock",
        allowedOrigins: ["http://127.0.0.1:5227", "https://web.example"],
        allowedRoots: ["/workspace/project/workspaces", "/tmp/shared"],
        logLevel: "debug",
        logFile: "/workspace/project/logs/muximod.log",
        workingDirectory: "/workspace/project",
        runtimeEnvironment: {
          ...runtimeEnvironment,
          tmuxSocket: "run/tmux.sock",
          muximoCommand: "/opt/muximo",
          codexRemote: "https://codex.example",
          codexBinary: "/opt/bin/codex",
          migrationsDirectory: "/workspace/project/migrations",
        },
      }),
    ],
  },
  {
    name: "rejects wildcard browser origins before bootstrap",
    input: {
      environment: { MUXIMOD_ALLOWED_ORIGINS: "*" },
      workingDirectory: "/workspace/project",
      daemon: { host: "127.0.0.1", port: 4317, pidFile: "/ignored/pid" },
    },
    assert: [hasError<ConfigContext, MuximodConfig>({ message: "wildcard browser origins are not allowed" })],
  },
] satisfies readonly OperationCase<"default", ConfigInput, MuximodConfig, ConfigContext>[];

const table: OperationTable<undefined, "default", ConfigInput, MuximodConfig, ConfigContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => createMuximodConfigResolver(input)(input.daemon),
  observe: () => ({}),
};

describe("muximod CLI configuration boundary", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
