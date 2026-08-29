import {
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { resolveWebOptions } from "./options.js";

type WebInput = { name?: string; environment?: NodeJS.ProcessEnv };
type WebResult = ReturnType<typeof resolveWebOptions>;
type WebContext = {
  environmentName: string | null;
  host: string;
  port: number;
  externalPort: number;
  instanceDirectory: string;
  muximodPort: string | null;
  muximoEnvironment: string | null;
};

const cases = [
  {
    name: "uses Web defaults without selecting an environment profile",
    input: {},
    assert: [
      hasObserved<WebContext, WebResult>("environmentName", null),
      hasObserved<WebContext, WebResult>("host", "127.0.0.1"),
      hasObserved<WebContext, WebResult>("port", 5227),
      hasObserved<WebContext, WebResult>("externalPort", 8449),
      hasObserved<WebContext, WebResult>("instanceDirectory", "<home>/.local/state/muximo/web"),
      hasObserved<WebContext, WebResult>("muximoEnvironment", null),
    ],
  },
  {
    name: "applies arbitrary profile values and ignores muximod-only values",
    input: {
      name: "dev",
      environment: {
        HOME: "/home/test",
        MUXIMO_WEB_HOST: "192.168.50.10",
        MUXIMO_WEB_PORT: "5999",
        MUXIMO_WEB_SERVE_PORT: "9449",
        MUXIMO_MUXIMOD_PORT: "not-a-port",
      },
    },
    assert: [
      hasObserved<WebContext, WebResult>("environmentName", "dev"),
      hasObserved<WebContext, WebResult>("host", "192.168.50.10"),
      hasObserved<WebContext, WebResult>("port", 5999),
      hasObserved<WebContext, WebResult>("externalPort", 9449),
      hasObserved<WebContext, WebResult>("instanceDirectory", "<home>/.local/state/muximo/dev/web"),
      hasObserved<WebContext, WebResult>("muximodPort", "not-a-port"),
      hasObserved<WebContext, WebResult>("muximoEnvironment", "dev"),
    ],
  },
] satisfies readonly OperationCase<"default", WebInput, WebResult, WebContext>[];

const table: OperationTable<undefined, "default", WebInput, WebResult, WebContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) =>
    resolveWebOptions(
      {
        name: input.name,
        repositoryRoot: "/muximo",
        environment: { HOME: "/home/test", ...input.environment },
      },
      "/workspace",
    ),
  observe: (_fixture, result) =>
    result.ok
      ? {
          environmentName: result.value.environmentName ?? null,
          host: result.value.host,
          port: result.value.port,
          externalPort: result.value.externalPort,
          instanceDirectory: result.value.webInstanceDirectory.replace("/home/test", "<home>"),
          muximodPort: result.value.environment.MUXIMO_MUXIMOD_PORT ?? null,
          muximoEnvironment: result.value.environment.MUXIMO_ENV ?? null,
        }
      : {
          environmentName: null,
          host: "",
          port: 0,
          externalPort: 0,
          instanceDirectory: "",
          muximodPort: null,
          muximoEnvironment: null,
        },
};

describe("Web runtime options", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
