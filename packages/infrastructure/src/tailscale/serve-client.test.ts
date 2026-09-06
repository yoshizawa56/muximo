import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  createTailscaleServeClient,
  fingerprintRoute,
  inspectTailscaleServeRoute,
  type TailscaleServeRoute,
  type TailscaleServeRouteExpectation,
  type TailscaleServeRouteStatus,
} from "./serve-client.js";

type CleanupInput = {
  kind: "exact" | "invalid-fingerprint" | "changed-route" | "configured-prefix";
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
  {
    name: "prepends configured argv values without invoking a shell",
    input: { kind: "configured-prefix" },
    assert: [
      hasObserved<CleanupContext, string>("commands", [
        ["--socket", "/run/tailscaled.sock", "serve", "status", "--json"],
        ["--socket", "/run/tailscaled.sock", "serve", "--https=8444", "--yes", "http://127.0.0.1:4317", "off"],
      ]),
    ],
  },
] satisfies readonly OperationCase<"default", CleanupInput, string, CleanupContext>[];

const table: OperationTable<CleanupFixture, "default", CleanupInput, string, CleanupContext> = {
  defaultFixture: () => ({ fixture: { commands: [] } }),
  cases,
  execute: async (fixture, input) => {
    const client = createTailscaleServeClient({
      environment:
        input.kind === "configured-prefix" ? { MUXIMO_TAILSCALE_ARGS: '["--socket", "/run/tailscaled.sock"]' } : {},
      binary: "tailscale",
      run: async (_command, args) => {
        fixture.commands.push([...args]);
        const commandArgs = input.kind === "configured-prefix" ? args.slice(2) : args;
        if (commandArgs[0] === "serve" && commandArgs[1] === "status") return { stdout: liveStatus, stderr: "" };
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
    if (input.kind === "configured-prefix") {
      await client.removeRoute(route);
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

type InspectionInput = {
  kind: "exact" | "unrelated" | "wrong-target" | "missing-path" | "invalid-json";
};

type InspectionFixture = {
  expected: TailscaleServeRouteExpectation;
  statusJson: Record<InspectionInput["kind"], string>;
};

type InspectionContext = {
  status: TailscaleServeRouteStatus;
};

const inspectionExpected: TailscaleServeRouteExpectation = {
  hostname: "machine.tailnet.ts.net",
  localTarget: "http://127.0.0.1:4317",
  externalPort: 8444,
  path: "/",
};

const inspectionStatus = {
  exact: liveStatus,
  unrelated: JSON.stringify({
    Web: {
      "other.tailnet.ts.net:8444": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
      },
    },
  }),
  "wrong-target": JSON.stringify({
    Web: {
      "machine.tailnet.ts.net:8444": {
        Handlers: { "/": { Proxy: "http://127.0.0.1:9999" } },
      },
    },
  }),
  "missing-path": JSON.stringify({
    Web: {
      "machine.tailnet.ts.net:8444": {
        Handlers: { "/other": { Proxy: "http://127.0.0.1:4317" } },
      },
    },
  }),
  "invalid-json": "not json",
} satisfies Record<InspectionInput["kind"], string>;

const inspectionCases = [
  {
    name: "reports only the expected live endpoint",
    input: { kind: "exact" },
    assert: [
      hasObserved<InspectionContext, TailscaleServeRouteStatus>("status", {
        endpointAvailable: true,
        pathAvailable: true,
        proxyTargetMatches: true,
      }),
    ],
  },
  {
    name: "ignores unrelated provider routes",
    input: { kind: "unrelated" },
    assert: [
      hasObserved<InspectionContext, TailscaleServeRouteStatus>("status", {
        endpointAvailable: false,
        pathAvailable: false,
        proxyTargetMatches: false,
      }),
    ],
  },
  {
    name: "reports a matching endpoint with a wrong proxy target",
    input: { kind: "wrong-target" },
    assert: [
      hasObserved<InspectionContext, TailscaleServeRouteStatus>("status", {
        endpointAvailable: true,
        pathAvailable: true,
        proxyTargetMatches: false,
      }),
    ],
  },
  {
    name: "reports a missing expected path",
    input: { kind: "missing-path" },
    assert: [
      hasObserved<InspectionContext, TailscaleServeRouteStatus>("status", {
        endpointAvailable: true,
        pathAvailable: false,
        proxyTargetMatches: false,
      }),
    ],
  },
  {
    name: "treats invalid provider JSON as unavailable",
    input: { kind: "invalid-json" },
    assert: [
      hasObserved<InspectionContext, TailscaleServeRouteStatus>("status", {
        endpointAvailable: false,
        pathAvailable: false,
        proxyTargetMatches: false,
      }),
    ],
  },
] satisfies readonly OperationCase<"default", InspectionInput, TailscaleServeRouteStatus, InspectionContext>[];

const inspectionTable: OperationTable<
  InspectionFixture,
  "default",
  InspectionInput,
  TailscaleServeRouteStatus,
  InspectionContext
> = {
  defaultFixture: () => ({ fixture: { expected: inspectionExpected, statusJson: inspectionStatus } }),
  cases: inspectionCases,
  execute: (fixture, input) => inspectTailscaleServeRoute(fixture.statusJson[input.kind], fixture.expected),
  observe: (_fixture, result) => ({
    status: result.ok ? result.value : { endpointAvailable: false, pathAvailable: false, proxyTargetMatches: false },
  }),
};

describe("Tailscale Serve route inspection", () => {
  runOperationTable(it as unknown as TestRegistrar, inspectionTable);
});
