import type { MuximodApplication, MuximodAuthPort } from "@muximo/application";
import type { MuximodEvent } from "@muximo/contract/api";
import {
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { EventPublisher } from "@orpc/server";
import { describe, it } from "vitest";
import { createMuximodApp } from "./app.js";
import { createOriginPolicy } from "./middleware.js";
import { createHttpTestClient } from "./test-client.js";
import { createTestMuximodSocketFactory } from "./test-socket.js";

const event: MuximodEvent = {
  type: "session_updated",
  sessionName: "integration",
  reason: "pane_created",
  revision: 4,
};
const authContext = {
  sessionId: "session-events-test-00000",
  serverId: "server-events-test-00000",
  deviceId: "device-events-test-00000",
  issuedAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2099-08-15T00:00:00.000Z",
  device: {
    deviceId: "device-events-test-00000",
    serverId: "server-events-test-00000",
    publicKey: { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y" },
    keyFingerprint: "fingerprint-events-test",
    displayName: "Events test",
    deviceType: "browser" as const,
    status: "active" as const,
    createdAt: "2026-08-15T00:00:00.000Z",
    approvedAt: "2026-08-15T00:00:00.000Z",
  },
};

type EventStep = { type: "open" | "publish" | "read" | "close" };
type EventFixture = {
  publisher: EventPublisher<{ muximod: MuximodEvent }>;
  client: ReturnType<typeof createHttpTestClient>;
  iterator?: AsyncIteratorObject<MuximodEvent>;
  received?: IteratorResult<MuximodEvent>;
  originalFetch: typeof globalThis.fetch;
};
type EventContext = { received: MuximodEvent | null; done: boolean | null };

const eventFixture = (): FixtureHandle<EventFixture> => {
  const originalFetch = globalThis.fetch;
  const publisher = new EventPublisher<{ muximod: MuximodEvent }>({ maxBufferedEvents: 1 });
  const app = createMuximodApp({
    auth: testAuth,
    application: createApplication(),
    configurationFingerprint: "0".repeat(64),
    originPolicy: createOriginPolicy({ allowedOrigins: ["http://muximod.local"], allowNoOrigin: true }),
    hookToken: "hook",
    socketFactory: createTestMuximodSocketFactory(),
    subscribeEvents: (signal) => publisher.subscribe("muximod", { signal }),
  });
  globalThis.fetch = (async (input, init) => {
    const response = await app.fetch(new Request(input, init));
    return response ?? new Response(null, { status: 101 });
  }) as typeof globalThis.fetch;
  const fixture: EventFixture = {
    publisher,
    client: createHttpTestClient({
      httpBaseUrl: "http://muximod.local",
      origin: "http://muximod.local",
      auth: { getAccessToken: async () => "events-token" },
    }),
    originalFetch,
  };
  return {
    fixture,
    cleanup: async () => {
      await fixture.iterator?.return?.();
      globalThis.fetch = fixture.originalFetch;
    },
  };
};

const cases = [
  {
    name: "delivers typed best-effort events through the oRPC event iterator",
    steps: [{ type: "open" }, { type: "publish" }, { type: "read" }, { type: "close" }],
    assert: [
      hasObserved<EventContext, undefined>("received", event),
      hasObserved<EventContext, undefined>("done", false),
    ],
  },
] satisfies readonly ScenarioCase<"default", EventStep, undefined, EventContext>[];

const table: ScenarioTable<EventFixture, "default", EventStep, undefined, EventContext> = {
  defaultFixture: eventFixture,
  cases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "open") fixture.iterator = await fixture.client.openEvents();
      else if (step.type === "publish") fixture.publisher.publish("muximod", event);
      else if (step.type === "read") fixture.received = await fixture.iterator!.next();
      else await fixture.iterator?.return?.();
    }
  },
  observe: (fixture) => ({
    received: fixture.received?.value ?? null,
    done: fixture.received?.done ?? null,
  }),
};

describe("muximod event transport", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

const testAuth: MuximodAuthPort = {
  serverId: authContext.serverId,
  authenticateAccessToken: async (token) => (token === "events-token" ? authContext : undefined),
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
  consumeWebSocketTicket: async () => undefined,
};

function createApplication(): MuximodApplication {
  return {
    agentSessions: {
      prepareRun: async () => {
        throw new Error("not used");
      },
      prepareResume: async () => {
        throw new Error("not used");
      },
      attach: async () => {
        throw new Error("not used");
      },
      completeRun: async () => {
        throw new Error("not used");
      },
      completeResume: async () => {
        throw new Error("not used");
      },
      startCleanup: async () => {
        throw new Error("not used");
      },
      list: async () => ({ allViews: [], views: [] }),
    },
    operations: {
      get: async () => {
        throw new Error("not used");
      },
      cancel: async () => {
        throw new Error("not used");
      },
    },
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
      list: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      manage: async () => ({ name: "unused", changed: false }),
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
