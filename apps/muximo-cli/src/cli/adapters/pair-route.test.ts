import type { ServeCommandOptions } from "@muximo/infrastructure";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { resolvePairMuximodBaseUrl } from "./pair-route.js";

type PairInput = {
  withoutServe: boolean;
  environment: NodeJS.ProcessEnv;
};

type PairFixture = {
  ensureCalls: Array<{ options: ServeCommandOptions; origins: readonly string[] }>;
  commandCount: number;
};

type PairContext = {
  url: string | null;
  ensureCount: number;
  muximodPort: number | null;
  origins: readonly string[];
  commandCount: number;
};

const cases = [
  {
    name: "uses the injected lifecycle for a local pairing route",
    input: {
      withoutServe: true,
      environment: { MUXIMOD_HOST: "127.0.0.1", MUXIMOD_PORT: "4321" },
    },
    assert: [
      hasObserved<PairContext, string>("url", "http://127.0.0.1:4321"),
      hasObserved<PairContext, string>("muximodPort", 4321),
      hasObserved<PairContext, string>("origins", ["http://127.0.0.1:4321"]),
      hasObserved<PairContext, string>("ensureCount", 1),
      hasObserved<PairContext, string>("commandCount", 0),
    ],
  },
] satisfies readonly OperationCase<"default", PairInput, string, PairContext>[];

const table: OperationTable<PairFixture, "default", PairInput, string, PairContext> = {
  defaultFixture: () => ({ fixture: { ensureCalls: [], commandCount: 0 } }),
  cases,
  execute: async (fixture, input) =>
    resolvePairMuximodBaseUrl(input, {
      ensureMuximod: async (options, origins) => {
        fixture.ensureCalls.push({ options, origins });
      },
      runCommand: async () => {
        fixture.commandCount += 1;
        return { stdout: "", stderr: "" };
      },
    }),
  observe: (fixture, result) => ({
    url: result.ok ? result.value : null,
    ensureCount: fixture.ensureCalls.length,
    muximodPort: fixture.ensureCalls[0]?.options.muximodPort ?? null,
    origins: fixture.ensureCalls[0]?.origins ?? [],
    commandCount: fixture.commandCount,
  }),
};

describe("muximo pairing route composition", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
