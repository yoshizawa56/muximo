import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createMuximodRuntimeEnvironment } from "./muximod-config.js";
import type { MuximoCliRuntimeOptions } from "./runtime-types.js";

type RuntimeEnvironmentInput = {
  environment: NodeJS.ProcessEnv;
  workingDirectory: string;
  runtime: MuximoCliRuntimeOptions;
};
type RuntimeEnvironmentContext = {};

function createRuntime(): MuximoCliRuntimeOptions {
  return {
    instanceDirectory: "/home/test/.local/state/muximo",
    configFile: "/home/test/.local/state/muximo/config.json",
    databaseFile: "/home/test/.local/state/muximo/muximod.sqlite",
    hookOutputDirectory: "/home/test/.local/state/muximo/hooks",
    pidFile: "/home/test/.local/state/muximo/muximod.pid",
    controlSocket: "/home/test/.local/state/muximo/muximod.sock",
    logFile: "/home/test/.local/state/muximo/muximod.log",
    serveStateFile: "/home/test/.local/state/muximo/serve.json",
    opencodeRegistryFile: "/home/test/.local/state/muximo/opencode-servers.json",
    verbose: false,
  };
}

const cases = [
  {
    name: "captures host context without durable daemon settings",
    input: {
      environment: { HOME: "/home/test", PATH: "/usr/bin", CODEX_HOME: "/home/test/.codex" },
      workingDirectory: "/workspace/project",
      runtime: createRuntime(),
    },
    assert: [
      returns<RuntimeEnvironmentContext, ReturnType<typeof createMuximodRuntimeEnvironment>>({
        homeDirectory: "/home/test",
        path: "/usr/bin",
        codexHome: "/home/test/.codex",
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
      }),
    ],
  },
  {
    name: "resolves only the explicitly supplied migration directory",
    input: {
      environment: { MUXIMOD_MIGRATIONS_DIR: "migrations", MUXIMO_CODEX_BIN: "/ignored/codex" },
      workingDirectory: "/workspace/project",
      runtime: createRuntime(),
    },
    assert: [
      returns<RuntimeEnvironmentContext, ReturnType<typeof createMuximodRuntimeEnvironment>>({
        homeDirectory: null,
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
        migrationsDirectory: "/workspace/project/migrations",
      }),
    ],
  },
] satisfies readonly OperationCase<
  "default",
  RuntimeEnvironmentInput,
  ReturnType<typeof createMuximodRuntimeEnvironment>,
  RuntimeEnvironmentContext
>[];

const table: OperationTable<
  undefined,
  "default",
  RuntimeEnvironmentInput,
  ReturnType<typeof createMuximodRuntimeEnvironment>,
  RuntimeEnvironmentContext
> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => createMuximodRuntimeEnvironment(input),
  observe: () => ({}),
};

describe("muximod process runtime environment", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
