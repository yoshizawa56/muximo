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
import type { CliBuildMode } from "./build-mode.js";
import { resolveMuximoCliRuntimeOptions } from "./runtime.js";

type RuntimeInput = {
  raw?: Record<string, unknown>;
  args?: readonly string[];
  environment?: NodeJS.ProcessEnv;
  buildMode?: CliBuildMode;
};
type RuntimeResult = ReturnType<typeof resolveMuximoCliRuntimeOptions>;
type RuntimeContext = {
  environmentName: string | null;
  muximoEnvironment: string | null;
  schemaMode: string | null;
  host: string | null;
  port: number | null;
  instanceDirectory: string | null;
  opencodeRegistryFile: string | null;
  webPort: string | null;
};

const cases = [
  {
    name: "uses migrate as the schema default without a selected profile",
    input: { environment: { HOME: "/home/test" } },
    assert: [
      hasObserved<RuntimeContext, RuntimeResult>("environmentName", null),
      hasObserved<RuntimeContext, RuntimeResult>("muximoEnvironment", null),
      hasObserved<RuntimeContext, RuntimeResult>("schemaMode", "migrate"),
      hasObserved<RuntimeContext, RuntimeResult>("host", "127.0.0.1"),
      hasObserved<RuntimeContext, RuntimeResult>("port", 4317),
      hasObserved<RuntimeContext, RuntimeResult>("instanceDirectory", "<home>/.local/state/muximo/muximod"),
      hasObserved<RuntimeContext, RuntimeResult>(
        "opencodeRegistryFile",
        "<home>/.local/state/muximo/opencode-servers.json",
      ),
    ],
  },
  {
    name: "applies explicit profile values regardless of the profile name",
    input: {
      environment: {
        MUXIMO_ENV: "dev",
        HOME: "/home/test",
        MUXIMO_MUXIMOD_HOST: "192.168.50.10",
        MUXIMO_MUXIMOD_PORT: "4327",
        MUXIMO_SCHEMA_MODE: "migrate",
        MUXIMO_WEB_PORT: "5999",
      },
    },
    assert: [
      hasObserved<RuntimeContext, RuntimeResult>("environmentName", "dev"),
      hasObserved<RuntimeContext, RuntimeResult>("muximoEnvironment", "dev"),
      hasObserved<RuntimeContext, RuntimeResult>("schemaMode", "migrate"),
      hasObserved<RuntimeContext, RuntimeResult>("host", "192.168.50.10"),
      hasObserved<RuntimeContext, RuntimeResult>("port", 4327),
      hasObserved<RuntimeContext, RuntimeResult>("instanceDirectory", "<home>/.local/state/muximo/dev/muximod"),
      hasObserved<RuntimeContext, RuntimeResult>(
        "opencodeRegistryFile",
        "<home>/.local/state/muximo/opencode-servers.json",
      ),
      hasObserved<RuntimeContext, RuntimeResult>("webPort", "5999"),
    ],
  },
  {
    name: "keeps migrate as the default for a local-named profile",
    input: { environment: { MUXIMO_ENV: "local" } },
    assert: [hasObserved<RuntimeContext, RuntimeResult>("schemaMode", "migrate")],
  },
  {
    name: "keeps the production runtime unscoped without a selected profile",
    input: {
      buildMode: "production",
      environment: { HOME: "/home/test", MUXIMO_ENV: "dev", MUXIMO_MUXIMOD_PORT: "4327" },
    },
    assert: [
      hasObserved<RuntimeContext, RuntimeResult>("environmentName", null),
      hasObserved<RuntimeContext, RuntimeResult>("muximoEnvironment", null),
      hasObserved<RuntimeContext, RuntimeResult>("port", 4327),
      hasObserved<RuntimeContext, RuntimeResult>("instanceDirectory", "<home>/.local/state/muximo/muximod"),
    ],
  },
  {
    name: "accepts push only when the profile explicitly requests it",
    input: { environment: { MUXIMO_ENV: "any-name", MUXIMO_SCHEMA_MODE: "push" } },
    assert: [hasObserved<RuntimeContext, RuntimeResult>("schemaMode", "push")],
  },
  {
    name: "lets a CLI option override a profile value",
    input: {
      raw: { schemaMode: "migrate", muximodPort: 4555 },
      args: ["--schema-mode", "migrate", "--muximod-port", "4555"],
      environment: { MUXIMO_ENV: "dev", MUXIMO_SCHEMA_MODE: "push", MUXIMO_MUXIMOD_PORT: "4327" },
    },
    assert: [
      hasObserved<RuntimeContext, RuntimeResult>("schemaMode", "migrate"),
      hasObserved<RuntimeContext, RuntimeResult>("port", 4555),
    ],
  },
  {
    name: "rejects a public muximod bind address",
    input: { environment: { MUXIMO_MUXIMOD_HOST: "0.0.0.0" } },
    assert: [hasError<RuntimeContext, RuntimeResult>({ message: /MUXIMO_MUXIMOD_HOST must be localhost/ })],
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
      buildMode: input.buildMode,
    }),
  observe: (_fixture, result) =>
    result.ok
      ? {
          environmentName: result.value.runtime.environmentName ?? null,
          muximoEnvironment: result.value.environment.MUXIMO_ENV ?? null,
          schemaMode: result.value.runtime.schemaMode,
          host: result.value.runtime.muximodHost,
          port: result.value.runtime.muximodPort,
          instanceDirectory: result.value.runtime.muximodInstanceDirectory.replace("/home/test", "<home>"),
          opencodeRegistryFile:
            result.value.environment.MUXIMO_OPENCODE_REGISTRY_FILE?.replace("/home/test", "<home>") ?? null,
          webPort: result.value.environment.MUXIMO_WEB_PORT ?? null,
        }
      : {
          environmentName: null,
          muximoEnvironment: null,
          schemaMode: null,
          host: null,
          port: null,
          instanceDirectory: null,
          opencodeRegistryFile: null,
          webPort: null,
        },
};

describe("muximo CLI runtime options", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
