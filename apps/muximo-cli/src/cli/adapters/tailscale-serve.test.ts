import { ensureTailscaleServe, type TailscaleServeResult } from "@muximo/infrastructure/cli-client";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";

type ServeFixture = {
  commands: string[][];
  commandCount: number;
};

type ServeInput = {
  environment: NodeJS.ProcessEnv;
  hostname?: string;
  failCommand?: boolean;
};

const cases = [
  {
    name: "discovers the hostname and configures a persistent loopback route",
    input: { environment: {} },
    assert: [
      hasObserved<ServeFixture, TailscaleServeResult>("commandCount", 3),
      hasObserved<ServeFixture, TailscaleServeResult>("commands", [
        ["status", "--json"],
        ["serve", "--bg", "--https=8444", "--yes", "http://127.0.0.1:4317"],
        ["serve", "status", "--json"],
      ]),
    ],
  },
  {
    name: "uses an explicitly configured hostname without a discovery call",
    input: { environment: { MUXIMO_TAILSCALE_HOSTNAME: "machine.tailnet.ts.net" } },
    assert: [
      hasObserved<ServeFixture, TailscaleServeResult>("commandCount", 2),
      hasObserved<ServeFixture, TailscaleServeResult>("commands", [
        ["serve", "--bg", "--https=8444", "--yes", "http://127.0.0.1:4317"],
        ["serve", "status", "--json"],
      ]),
    ],
  },
  {
    name: "reports a provider failure without managing a daemon as a side effect",
    input: { environment: {}, failCommand: true },
    assert: [hasError<ServeFixture, TailscaleServeResult>({ message: /provider failed/ })],
  },
] satisfies readonly OperationCase<"default", ServeInput, TailscaleServeResult, ServeFixture>[];

const table: OperationTable<ServeFixture, "default", ServeInput, TailscaleServeResult, ServeFixture> = {
  defaultFixture: () => ({ fixture: { commands: [], commandCount: 0 } }),
  cases,
  execute: (fixture, input) =>
    ensureTailscaleServe(
      {
        provider: "tailscale",
        localPort: 4317,
        externalPort: 8444,
        ...(input.hostname === undefined ? {} : {}),
      },
      {
        runCommand: async (_command, args, _options) => {
          fixture.commands.push([...args]);
          fixture.commandCount += 1;
          if (input.failCommand) throw new Error("provider failed");
          if (args[0] === "status" && args[1] === "--json") {
            return { stdout: JSON.stringify({ Self: { DNSName: "machine.tailnet.ts.net." } }), stderr: "" };
          }
          if (args[0] === "serve" && args[1] === "status") {
            return {
              stdout: JSON.stringify({
                Web: {
                  "machine.tailnet.ts.net:8444": {
                    Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } },
                  },
                },
              }),
              stderr: "",
            };
          }
          return { stdout: "provider output\n", stderr: "" };
        },
      },
      { ...input.environment, ...(input.hostname ? { MUXIMO_TAILSCALE_HOSTNAME: input.hostname } : {}) },
    ),
  observe: (fixture) => ({ ...fixture }),
};

describe("muximo Tailscale route composition", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
