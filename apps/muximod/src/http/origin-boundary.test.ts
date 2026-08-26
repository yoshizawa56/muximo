import type { MuximodApplication, MuximodAuthPort } from "@muximo/application";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createMuximodApp, type MuximodApp } from "./app.js";
import { createOriginPolicy, muximoCapacitorOrigin } from "./middleware.js";
import { createHttpTestClient } from "./test-client.js";
import { createTestMuximodSocketFactory } from "./test-socket.js";

const allowedOrigin = "http://web.example";
const customOrigin = "capacitor://evil.example";
const deniedOrigin = "http://evil.example";
const authContext = {
  sessionId: "session-origin-test-000000",
  serverId: "server-origin-test-000000",
  deviceId: "device-origin-test-000000",
  issuedAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2099-08-15T00:00:00.000Z",
  device: {
    deviceId: "device-origin-test-000000",
    serverId: "server-origin-test-000000",
    publicKey: { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y" },
    keyFingerprint: "fingerprint-origin-test",
    displayName: "Origin test",
    deviceType: "browser" as const,
    status: "active" as const,
    createdAt: "2026-08-15T00:00:00.000Z",
    approvedAt: "2026-08-15T00:00:00.000Z",
  },
};

type OriginInput = {
  route: "rpc" | "events" | "terminal";
  origin: "allowed" | "capacitor" | "custom" | "denied" | "none";
};
type OriginResult = { status: number; body: unknown };
type OriginFixture = {
  app: MuximodApp;
  server: { upgrade(request: Request, options: unknown): boolean };
  authCalls: number;
  sessionsCalls: number;
  subscriptions: number;
  consumedTickets: number;
  upgrades: number;
  originalFetch: typeof globalThis.fetch;
  lastResponse: Response | null;
  lastStatus: number;
};
type OriginContext = {
  status: number;
  authCalls: number;
  sessionsCalls: number;
  subscriptions: number;
  consumedTickets: number;
  upgrades: number;
};

const fixture = (allowNoOrigin: boolean): FixtureHandle<OriginFixture> => {
  const state = {
    authCalls: 0,
    sessionsCalls: 0,
    subscriptions: 0,
    consumedTickets: 0,
    upgrades: 0,
  };
  const auth: MuximodAuthPort = {
    serverId: authContext.serverId,
    authenticateAccessToken: async (token) => {
      state.authCalls += 1;
      return token === "origin-token" ? authContext : undefined;
    },
    claimPairing: async () => {
      throw new Error("not used");
    },
    pairingStatus: async () => {
      throw new Error("not used");
    },
    createChallenge: async () => {
      throw new Error("not used");
    },
    createSession: async () => {
      throw new Error("not used");
    },
    issueWebSocketTicket: async () => {
      throw new Error("not used");
    },
    consumeWebSocketTicket: async (ticket) => {
      if (ticket !== "origin-ticket") return undefined;
      state.consumedTickets += 1;
      return authContext;
    },
  };
  const application = createApplication(state);
  const originPolicy = allowNoOrigin
    ? createOriginPolicy({ allowedOrigins: [allowedOrigin], allowNoOrigin: true })
    : createOriginPolicy({ allowedOrigins: [allowedOrigin], allowNoOrigin: false });
  const app = createMuximodApp({
    auth,
    application,
    originPolicy,
    hookToken: "hook",
    socketFactory: createTestMuximodSocketFactory(),
    subscribeEvents: () => {
      state.subscriptions += 1;
      return events();
    },
  });
  const server = {
    upgrade: (_request: Request, _options: unknown) => {
      state.upgrades += 1;
      return true;
    },
  };
  const originalFetch = globalThis.fetch;
  const fixtureState: OriginFixture = {
    app,
    server,
    get authCalls() {
      return state.authCalls;
    },
    get sessionsCalls() {
      return state.sessionsCalls;
    },
    get subscriptions() {
      return state.subscriptions;
    },
    get consumedTickets() {
      return state.consumedTickets;
    },
    get upgrades() {
      return state.upgrades;
    },
    originalFetch,
    lastResponse: null,
    lastStatus: 0,
  };
  globalThis.fetch = (async (input, init) => {
    const response = await app.fetch(new Request(input, init), server);
    fixtureState.lastResponse = response ?? null;
    fixtureState.lastStatus = response?.status ?? 101;
    return response ?? new Response(null, { status: 101 });
  }) as typeof globalThis.fetch;
  return {
    fixture: fixtureState,
    cleanup: async () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const cases = [
  {
    name: "dispatches protected RPC from an allowlisted browser origin",
    input: { route: "rpc", origin: "allowed" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 200),
      hasObserved<OriginContext, OriginResult>("sessionsCalls", 1),
      hasObserved<OriginContext, OriginResult>("authCalls", 1),
    ],
  },
  {
    name: "rejects protected RPC from a non-allowlisted browser origin before auth",
    input: { route: "rpc", origin: "denied" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 403),
      hasObserved<OriginContext, OriginResult>("sessionsCalls", 0),
      hasObserved<OriginContext, OriginResult>("authCalls", 0),
    ],
  },
  {
    name: "dispatches protected RPC from the first-party Capacitor origin",
    input: { route: "rpc", origin: "capacitor" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 200),
      hasObserved<OriginContext, OriginResult>("sessionsCalls", 1),
      hasObserved<OriginContext, OriginResult>("authCalls", 1),
    ],
  },
  {
    name: "rejects a non-first-party custom origin before auth",
    input: { route: "rpc", origin: "custom" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 403),
      hasObserved<OriginContext, OriginResult>("sessionsCalls", 0),
      hasObserved<OriginContext, OriginResult>("authCalls", 0),
    ],
  },
  {
    name: "allows a protected RPC from a trusted no-Origin client",
    input: { route: "rpc", origin: "none" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 200),
      hasObserved<OriginContext, OriginResult>("sessionsCalls", 1),
      hasObserved<OriginContext, OriginResult>("authCalls", 1),
    ],
  },
  {
    name: "rejects protected RPC from no-Origin when the policy disallows it before auth",
    fixture: "no-origin-denied",
    input: { route: "rpc", origin: "none" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 403),
      hasObserved<OriginContext, OriginResult>("sessionsCalls", 0),
      hasObserved<OriginContext, OriginResult>("authCalls", 0),
    ],
  },
  {
    name: "dispatches authenticated SSE from an allowlisted origin",
    input: { route: "events", origin: "allowed" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 200),
      hasObserved<OriginContext, OriginResult>("subscriptions", 1),
    ],
  },
  {
    name: "rejects authenticated SSE from a non-allowlisted origin before subscription",
    input: { route: "events", origin: "denied" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 403),
      hasObserved<OriginContext, OriginResult>("subscriptions", 0),
      hasObserved<OriginContext, OriginResult>("authCalls", 0),
    ],
  },
  {
    name: "dispatches authenticated SSE from the first-party Capacitor origin",
    input: { route: "events", origin: "capacitor" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 200),
      hasObserved<OriginContext, OriginResult>("subscriptions", 1),
    ],
  },
  {
    name: "upgrades a terminal WebSocket from an allowlisted origin",
    input: { route: "terminal", origin: "allowed" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 101),
      hasObserved<OriginContext, OriginResult>("consumedTickets", 1),
      hasObserved<OriginContext, OriginResult>("upgrades", 1),
    ],
  },
  {
    name: "rejects a terminal WebSocket from a non-allowlisted origin before ticket use",
    input: { route: "terminal", origin: "denied" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 403),
      hasObserved<OriginContext, OriginResult>("consumedTickets", 0),
      hasObserved<OriginContext, OriginResult>("upgrades", 0),
    ],
  },
  {
    name: "upgrades a terminal WebSocket from the first-party Capacitor origin",
    input: { route: "terminal", origin: "capacitor" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 101),
      hasObserved<OriginContext, OriginResult>("consumedTickets", 1),
      hasObserved<OriginContext, OriginResult>("upgrades", 1),
    ],
  },
  {
    name: "allows a terminal WebSocket from a trusted no-Origin client",
    input: { route: "terminal", origin: "none" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 101),
      hasObserved<OriginContext, OriginResult>("consumedTickets", 1),
      hasObserved<OriginContext, OriginResult>("upgrades", 1),
    ],
  },
  {
    name: "rejects a terminal WebSocket from no-Origin when the policy disallows it before ticket use",
    fixture: "no-origin-denied",
    input: { route: "terminal", origin: "none" },
    assert: [
      hasObserved<OriginContext, OriginResult>("status", 403),
      hasObserved<OriginContext, OriginResult>("consumedTickets", 0),
      hasObserved<OriginContext, OriginResult>("upgrades", 0),
    ],
  },
] satisfies readonly OperationCase<"default" | "no-origin-denied", OriginInput, OriginResult, OriginContext>[];

const table: OperationTable<OriginFixture, "default" | "no-origin-denied", OriginInput, OriginResult, OriginContext> = {
  defaultFixture: () => fixture(true),
  fixtures: { default: () => fixture(true), "no-origin-denied": () => fixture(false) },
  cases,
  execute: async (testFixture, input) => {
    const origin =
      input.origin === "none"
        ? undefined
        : input.origin === "allowed"
          ? allowedOrigin
          : input.origin === "capacitor"
            ? muximoCapacitorOrigin
            : input.origin === "custom"
              ? customOrigin
              : deniedOrigin;
    if (input.route === "terminal") {
      const headers = new Headers({ upgrade: "websocket" });
      if (origin) headers.set("origin", origin);
      const response = await testFixture.app.fetch(
        new Request("http://muximod.local/terminal?ticket=origin-ticket", { headers }),
        testFixture.server,
      );
      testFixture.lastResponse = response ?? null;
      testFixture.lastStatus = response?.status ?? 101;
      return { status: response?.status ?? 101, body: response ? await response.json() : null };
    }

    const client = createHttpTestClient({
      httpBaseUrl: "http://muximod.local",
      ...(origin ? { origin } : {}),
      auth: { getAccessToken: async () => "origin-token" },
    });
    try {
      if (input.route === "rpc") await client.sessions();
      else {
        const iterator = await client.openEvents();
        await iterator.return?.();
      }
    } catch {
      // The row observes the response captured by the shared fetch adapter.
    }
    const response = testFixture.lastResponse;
    return { status: response?.status ?? 0, body: null };
  },
  observe: (testFixture) => ({
    status: testFixture.lastStatus,
    authCalls: testFixture.authCalls,
    sessionsCalls: testFixture.sessionsCalls,
    subscriptions: testFixture.subscriptions,
    consumedTickets: testFixture.consumedTickets,
    upgrades: testFixture.upgrades,
  }),
};

describe("muximod authenticated origin boundary", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createApplication(state: { sessionsCalls: number }): MuximodApplication {
  return {
    terminal: {
      get: async () => ({
        id: "terminal",
        name: "terminal",
        host: "host",
        tailnetIp: "100.64.0.1",
        state: "online",
        detail: "test",
        lastSeen: "now",
      }),
    },
    workspaces: {
      list: async () => [],
      browse: async () => [],
      register: async () => {
        throw new Error("not used");
      },
      update: async () => {
        throw new Error("not used");
      },
      delete: async () => {
        throw new Error("not used");
      },
    },
    sessions: {
      list: async () => {
        state.sessionsCalls += 1;
        return [];
      },
      manage: async () => ({ name: "unused", changed: false }),
      create: async () => {
        throw new Error("not used");
      },
    },
    panes: {
      list: async () => [],
      create: async () => {
        throw new Error("not used");
      },
    },
    hooks: { handleTerminalHostHook: async () => undefined },
  };
}

async function* events(): AsyncGenerator<never> {
  await new Promise<void>(() => undefined);
}
