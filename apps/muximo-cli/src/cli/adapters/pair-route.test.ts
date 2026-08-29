import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ServeRouteState, writeServeRouteState } from "@muximo/infrastructure/cli-client";
import {
  hasError,
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
  liveRoute: "match" | "mismatch";
};

type PairFixture = {
  stateFile: string;
  fetchedUrl?: string;
  originalFetch: typeof fetch;
};

type PairContext = { url: string | null; fetchedUrl: string | null };

const routeState: ServeRouteState = {
  schemaVersion: 2,
  environment: "local",
  component: "muximod",
  provider: "tailscale",
  hostname: "machine.tailnet.ts.net",
  publicUrl: "https://machine.tailnet.ts.net:8444/",
  localTarget: "http://127.0.0.1:4317",
  externalPort: 8444,
  path: "/",
  routeFingerprint: "route-fingerprint",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

const cases = [
  {
    name: "returns a live client-owned route",
    input: {
      withoutServe: false,
      environment: { MUXIMO_ENV: "local", MUXIMOD_HOST: "127.0.0.1", MUXIMOD_PORT: "4317" },
      liveRoute: "match",
    },
    assert: [
      hasObserved<PairContext, string>("url", routeState.publicUrl),
      hasObserved<PairContext, string>("fetchedUrl", "https://machine.tailnet.ts.net:8444/health"),
    ],
  },
  {
    name: "uses the fixed local endpoint when serving is explicitly disabled",
    input: {
      withoutServe: true,
      environment: { MUXIMO_ENV: "local", MUXIMOD_HOST: "127.0.0.1", MUXIMOD_PORT: "4317" },
      liveRoute: "match",
    },
    assert: [
      hasObserved<PairContext, string>("url", "http://127.0.0.1:4317"),
      hasObserved<PairContext, string>("fetchedUrl", "http://127.0.0.1:4317/health"),
    ],
  },
  {
    name: "rejects a route owned by another environment",
    input: {
      withoutServe: false,
      environment: { MUXIMO_ENV: "stg", MUXIMOD_HOST: "127.0.0.1", MUXIMOD_PORT: "4317" },
      liveRoute: "match",
    },
    assert: [hasError<PairContext, string>({ message: /different environment/ })],
  },
  {
    name: "rejects a route changed by the provider",
    input: {
      withoutServe: false,
      environment: { MUXIMO_ENV: "local", MUXIMOD_HOST: "127.0.0.1", MUXIMOD_PORT: "4317" },
      liveRoute: "mismatch",
    },
    assert: [hasError<PairContext, string>({ message: /does not match the live provider/ })],
  },
] satisfies readonly OperationCase<"default", PairInput, string, PairContext>[];

const table: OperationTable<PairFixture, "default", PairInput, string, PairContext> = {
  defaultFixture: () => {
    const root = mkdtempSync(join(tmpdir(), "muximo-pair-route-test-"));
    const stateFile = join(root, "serve.json");
    writeServeRouteState(stateFile, routeState);
    const originalFetch = globalThis.fetch;
    const fixture: PairFixture = { stateFile, originalFetch };
    globalThis.fetch = (async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fixture.fetchedUrl = url;
      return new Response(JSON.stringify({ ok: true, service: "muximod" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    return {
      fixture,
      cleanup: () => {
        globalThis.fetch = originalFetch;
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
  cases,
  execute: async (fixture, input) => {
    const result = await resolvePairMuximodBaseUrl(
      {
        withoutServe: input.withoutServe,
        environment: input.environment,
        routeStateFile: fixture.stateFile,
      },
      { verifyLiveRoute: async () => input.liveRoute === "match" },
    );
    return result;
  },
  observe: (fixture, result) => ({
    url: result.ok ? result.value : null,
    fetchedUrl: fixture.fetchedUrl ?? null,
  }),
};

describe("muximo pairing route composition", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
