import { resolveDevAllowedOrigins } from "@muximo/infrastructure";
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

type Input = {
  provider?: "tailscale";
  environment: NodeJS.ProcessEnv;
};

type Context = {};

const cases = [
  {
    name: "includes local and exact Tailscale web origins",
    input: {
      provider: "tailscale",
      environment: {
        VITE_DEV_PORT: "5227",
        MUXIMO_TAILSCALE_HOSTNAME: "web.tailnet.ts.net",
        MUXIMO_DEV_SERVE_PORT: "443",
      },
    },
    assert: [returns<Context, string[]>(["http://127.0.0.1:5227", "https://web.tailnet.ts.net"])],
  },
  {
    name: "keeps an explicitly configured origin list exact and ordered",
    input: {
      environment: { MUXIMOD_ALLOWED_ORIGINS: "https://remote.example,http://localhost:5227" },
    },
    assert: [returns<Context, string[]>(["http://localhost:5227", "https://remote.example"])],
  },
  {
    name: "rejects wildcard origins before the development supervisor starts",
    input: { environment: { MUXIMOD_ALLOWED_ORIGINS: "*" } },
    assert: [hasError<Context, string[]>({ message: "wildcard browser origins are not allowed" })],
  },
] satisfies readonly OperationCase<"default", Input, string[], Context>[];

const table: OperationTable<undefined, "default", Input, string[], Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => resolveDevAllowedOrigins({ serveProvider: input.provider }, input.environment),
  observe: () => ({}),
};

describe("muximo dev origin composition", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
});
