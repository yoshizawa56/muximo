import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createTailscaleServeClient, fingerprintRoute, type TailscaleServeRoute } from "./serve-client.js";

type CleanupInput = {
  kind: "exact" | "invalid-fingerprint" | "changed-route";
};

type CleanupFixture = {
  commands: string[][];
};

type CleanupContext = {
  commands: string[][];
};

const route: TailscaleServeRoute = {
  localPort: 4317,
  externalPort: 8444,
  hostname: "machine.tailnet.ts.net",
  localTarget: "http://127.0.0.1:4317",
  publicUrl: "https://machine.tailnet.ts.net:8444/",
  routeFingerprint: fingerprintRoute({
    hostname: "machine.tailnet.ts.net",
    localTarget: "http://127.0.0.1:4317",
    externalPort: 8444,
    path: "/",
  }),
};

const liveStatus = JSON.stringify({
  Web: {
    "machine.tailnet.ts.net:8444": {
      Handlers: { "/": { Proxy: "http://127.0.0.1:4317" } },
    },
  },
});

const cases = [
  {
    name: "removes the exact route after rechecking the live provider",
    input: { kind: "exact" },
    assert: [
      hasObserved<CleanupContext, string>("commands", [
        ["serve", "status", "--json"],
        ["serve", "--https=8444", "--yes", "http://127.0.0.1:4317", "off"],
      ]),
    ],
  },
  {
    name: "rejects a route with an invalid stored fingerprint",
    input: { kind: "invalid-fingerprint" },
    assert: [
      hasError<CleanupContext, string>({
        message: "refusing to remove a Tailscale Serve route with an invalid identity",
      }),
      hasObserved<CleanupContext, string>("commands", []),
    ],
  },
  {
    name: "rejects a route changed by another owner",
    input: { kind: "changed-route" },
    assert: [
      hasError<CleanupContext, string>({ message: /changed or missing Tailscale Serve route/ }),
      hasObserved<CleanupContext, string>("commands", [["serve", "status", "--json"]]),
    ],
  },
] satisfies readonly OperationCase<"default", CleanupInput, string, CleanupContext>[];

const table: OperationTable<CleanupFixture, "default", CleanupInput, string, CleanupContext> = {
  defaultFixture: () => ({ fixture: { commands: [] } }),
  cases,
  execute: async (fixture, input) => {
    const client = createTailscaleServeClient({
      environment: {},
      binary: "tailscale",
      run: async (_command, args) => {
        fixture.commands.push([...args]);
        if (args[0] === "serve" && args[1] === "status") return { stdout: liveStatus, stderr: "" };
        return { stdout: "removed\n", stderr: "" };
      },
    });
    if (input.kind === "exact") {
      await client.removeRoute(route);
      return "removed";
    }
    if (input.kind === "invalid-fingerprint") {
      await client.removeRoute({ ...route, routeFingerprint: "invalid" });
      return "removed";
    }
    const changedTarget = "http://127.0.0.1:9999";
    await client.removeRoute({
      ...route,
      localTarget: changedTarget,
      routeFingerprint: fingerprintRoute({
        hostname: route.hostname,
        localTarget: changedTarget,
        externalPort: route.externalPort,
        path: route.path,
      }),
    });
    return "removed";
  },
  observe: (fixture) => ({ commands: fixture.commands }),
};

describe("Tailscale Serve route ownership", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
