import {
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { resolveMuximoCliRuntimeOptions } from "./runtime.js";

type RuntimeInput = {
  raw?: Record<string, unknown>;
  args?: readonly string[];
  environment?: NodeJS.ProcessEnv;
};
type RuntimeResult = ReturnType<typeof resolveMuximoCliRuntimeOptions>;
type RuntimeContext = {
  instanceDirectory: string | null;
  configFile: string | null;
  databaseFile: string | null;
  controlSocket: string | null;
  legacyPort: string | null;
  muximoInstanceDirectory: string | null;
};

const cases = [
  {
    name: "uses the default instance directory under HOME",
    input: { environment: { HOME: "/home/test" } },
    assert: [
      hasObserved<RuntimeContext, RuntimeResult>("instanceDirectory", "/home/test/.local/state/muximo"),
      hasObserved<RuntimeContext, RuntimeResult>("configFile", "/home/test/.local/state/muximo/config.json"),
      hasObserved<RuntimeContext, RuntimeResult>("databaseFile", "/home/test/.local/state/muximo/muximod.sqlite"),
      hasObserved<RuntimeContext, RuntimeResult>("controlSocket", "/home/test/.local/state/muximo/muximod.sock"),
    ],
  },
  {
    name: "resolves a relative CLI instance directory from the current working directory",
    input: { raw: { instanceDirectory: "./state" }, args: ["--instance-dir", "./state"], environment: {} },
    assert: [hasObserved<RuntimeContext, RuntimeResult>("instanceDirectory", "/workspace/state")],
  },
  {
    name: "uses the instance directory environment binding",
    input: { environment: { MUXIMOD_INSTANCE_DIR: "/var/lib/muximo" } },
    assert: [hasObserved<RuntimeContext, RuntimeResult>("instanceDirectory", "/var/lib/muximo")],
  },
  {
    name: "removes legacy daemon configuration environment variables from child context",
    input: {
      environment: {
        HOME: "/home/test",
        MUXIMO_MUXIMOD_PORT: "4327",
        MUXIMO_SCHEMA_MODE: "push",
        MUXIMOD_WORKSPACE_ROOTS: "/workspace",
        MUXIMO_TAILSCALE_HOSTNAME: "machine.example",
      },
    },
    assert: [
      hasObserved<RuntimeContext, RuntimeResult>("legacyPort", null),
      hasObserved<RuntimeContext, RuntimeResult>("muximoInstanceDirectory", "/home/test/.local/state/muximo"),
    ],
  },
] satisfies readonly OperationCase<"default", RuntimeInput, RuntimeResult, RuntimeContext>[];

const table: OperationTable<undefined, "default", RuntimeInput, RuntimeResult, RuntimeContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) =>
    resolveMuximoCliRuntimeOptions({
      raw: input.raw ?? {},
      args: input.args ?? [],
      environment: input.environment ?? {},
      cwd: "/workspace",
    }),
  observe: (_fixture, result) =>
    result.ok
      ? {
          instanceDirectory: result.value.runtime.instanceDirectory,
          configFile: result.value.runtime.configFile,
          databaseFile: result.value.runtime.databaseFile,
          controlSocket: result.value.runtime.controlSocket,
          legacyPort: result.value.environment.MUXIMO_MUXIMOD_PORT ?? null,
          muximoInstanceDirectory: result.value.environment.MUXIMOD_INSTANCE_DIR ?? null,
        }
      : {
          instanceDirectory: null,
          configFile: null,
          databaseFile: null,
          controlSocket: null,
          legacyPort: null,
          muximoInstanceDirectory: null,
        },
};

describe("muximo CLI bootstrap runtime", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
