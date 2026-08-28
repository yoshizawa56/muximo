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

type ConfigInput = {
  environment: NodeJS.ProcessEnv;
  workingDirectory: string;
  daemon: DaemonOptions;
};
type ConfigContext = {};

const cases = [
  {
    name: "resolves persistent defaults from the command environment",
    input: {
      environment: { HOME: "/home/test" },
      workingDirectory: "/workspace/project",
      daemon: { host: "127.0.0.1", port: 4317, pidFile: "run/muximod.pid" },
    },
    assert: [
      returns<ConfigContext, MuximodConfig>({
        host: "127.0.0.1",
        port: 4317,
        instanceDirectory: "/home/test/.local/state/muximo",
        hookOutputDirectory: "/home/test/.local/state/muximo/hooks",
        pidFile: "/workspace/project/run/muximod.pid",
        controlSocket: "/home/test/.local/state/muximo/muximod.sock",
        muximodBaseUrl: "http://127.0.0.1:4317",
        allowedOrigins: [],
        allowedRoots: ["/workspace/project"],
        logLevel: "info",
        logFile: "/home/test/.local/state/muximo/muximod.log",
        workingDirectory: "/workspace/project",
        runtimeEnvironment: {
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
        },
      }),
    ],
  },
  {
    name: "normalizes environment paths and pairing settings before bootstrap",
    input: {
      environment: {
        HOME: "/home/test",
        MUXIMOD_INSTANCE_DIR: "state",
        MUXIMOD_TMUX_SOCKET: "run/tmux.sock",
        MUXIMO_WORKTREE_ID: "worktree-1",
        MUXIMO_WORKTREE_ROOT: "./worktrees",
        MUXIMOD_MUXIMO_COMMAND: "/opt/muximo",
        MUXIMO_CODEX_REMOTE: "https://codex.example",
        MUXIMO_CODEX_BIN: "/opt/bin/codex",
        MUXIMO_CLAUDE_BIN: "/opt/bin/claude",
        MUXIMO_OPENCODE_BIN: "/opt/bin/opencode",
        MUXIMOD_MIGRATIONS_DIR: "migrations",
        MUXIMOD_PAIRING_BASE_URL: "https://muximod.example/base/?ignored=yes#fragment",
        MUXIMOD_WORKSPACE_ROOTS: "./workspaces:/tmp/shared",
        MUXIMO_LOG_FILE: "logs/muximod.log",
        MUXIMO_LOG_LEVEL: "debug",
        MUXIMOD_ALLOWED_ORIGINS: "https://web.example/,http://127.0.0.1:5227/",
      },
      workingDirectory: "/workspace/project",
      daemon: { host: "127.0.0.1", port: 4317, pidFile: "run/muximod.pid" },
    },
    assert: [
      returns<ConfigContext, MuximodConfig>({
        host: "127.0.0.1",
        port: 4317,
        instanceDirectory: "/workspace/project/state",
        hookOutputDirectory: "/workspace/project/state/hooks",
        pidFile: "/workspace/project/run/muximod.pid",
        controlSocket: "/workspace/project/state/muximod.sock",
        muximodBaseUrl: "https://muximod.example/base",
        allowedOrigins: ["http://127.0.0.1:5227", "https://web.example"],
        allowedRoots: ["/workspace/project/workspaces", "/tmp/shared"],
        logLevel: "debug",
        logFile: "/workspace/project/logs/muximod.log",
        workingDirectory: "/workspace/project",
        runtimeEnvironment: {
          homeDirectory: "/home/test",
          path: null,
          codexHome: null,
          claudeConfigDirectory: null,
          tailscaleBinary: null,
          tmuxPane: null,
          tmuxSocket: "run/tmux.sock",
          worktreeId: "worktree-1",
          worktreeRoot: "./worktrees",
          muximoCommand: "/opt/muximo",
          codexRemote: "https://codex.example",
          codexBinary: "/opt/bin/codex",
          claudeBinary: "/opt/bin/claude",
          opencodeBinary: "/opt/bin/opencode",
          migrationsDirectory: "/workspace/project/migrations",
        },
      }),
    ],
  },
  {
    name: "prefers explicit daemon values over environment defaults",
    input: {
      environment: {
        HOME: "/home/test",
        MUXIMOD_PAIRING_BASE_URL: "https://environment.example",
        MUXIMO_LOG_FILE: "environment.log",
        MUXIMOD_ALLOWED_ORIGINS: "https://environment.example",
      },
      workingDirectory: "/workspace/project",
      daemon: {
        host: "127.0.0.1",
        port: 4999,
        pidFile: "run/muximod.pid",
        controlSocket: "run/muximod.sock",
        muximodBaseUrl: "http://127.0.0.1:4999/",
        logFile: "run/daemon.log",
        logLevel: "warn",
        allowedOrigins: ["https://explicit.example/"],
      },
    },
    assert: [
      returns<ConfigContext, MuximodConfig>({
        host: "127.0.0.1",
        port: 4999,
        instanceDirectory: "/home/test/.local/state/muximo",
        hookOutputDirectory: "/home/test/.local/state/muximo/hooks",
        pidFile: "/workspace/project/run/muximod.pid",
        controlSocket: "/workspace/project/run/muximod.sock",
        muximodBaseUrl: "http://127.0.0.1:4999",
        allowedOrigins: ["https://explicit.example"],
        allowedRoots: ["/workspace/project"],
        logLevel: "warn",
        logFile: "/workspace/project/run/daemon.log",
        workingDirectory: "/workspace/project",
        runtimeEnvironment: {
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
        },
      }),
    ],
  },
  {
    name: "rejects wildcard browser origins before starting muximod",
    input: {
      environment: { MUXIMOD_ALLOWED_ORIGINS: "*" },
      workingDirectory: "/workspace/project",
      daemon: { host: "127.0.0.1", port: 4317, pidFile: "/tmp/muximod.pid" },
    },
    assert: [hasError<ConfigContext, MuximodConfig>({ message: "wildcard browser origins are not allowed" })],
  },
  {
    name: "rejects non-http pairing base URLs before bootstrap",
    input: {
      environment: { MUXIMOD_PAIRING_BASE_URL: "ftp://muximod.example" },
      workingDirectory: "/workspace/project",
      daemon: { host: "127.0.0.1", port: 4317, pidFile: "/tmp/muximod.pid" },
    },
    assert: [
      hasError<ConfigContext, MuximodConfig>({
        message: "muximod base URL must use http or https: ftp://muximod.example",
      }),
    ],
  },
  {
    name: "rejects pairing base URLs containing credentials before bootstrap",
    input: {
      environment: { MUXIMOD_PAIRING_BASE_URL: "https://user:password@muximod.example" },
      workingDirectory: "/workspace/project",
      daemon: { host: "127.0.0.1", port: 4317, pidFile: "/tmp/muximod.pid" },
    },
    assert: [
      hasError<ConfigContext, MuximodConfig>({
        message: "muximod base URL must not contain credentials",
      }),
    ],
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
