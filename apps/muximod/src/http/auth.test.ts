import type { MuximodApplication } from "@muximo/application";
import {
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createMuximodApp, type MuximodApp, type MuximodAuthPort } from "./app.js";
import { createOriginPolicy } from "./middleware.js";
import { createHttpTestClient } from "./test-client.js";
import { createTestMuximodSocketFactory } from "./test-socket.js";

const serverId = "server-auth-test-000000";
const auth: MuximodAuthPort = {
  serverId,
  authenticateAccessToken: async () => undefined,
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

type HttpStep = { type: "health" | "info" | "protected" | "preflight" };
type HttpFixture = {
  app: MuximodApp;
  statuses: Record<string, number>;
  origins: Record<string, string | null>;
  lastResponse: { status: number; origin: string | null } | null;
  originalFetch: typeof globalThis.fetch;
};
type HttpContext = {
  statuses: Readonly<Record<string, number>>;
  origins: Readonly<Record<string, string | null>>;
};

const httpFixture = (): FixtureHandle<HttpFixture> => {
  const originalFetch = globalThis.fetch;
  const app = createMuximodApp({
    auth,
    application: createApplication(),
    originPolicy: createOriginPolicy({ allowedOrigins: ["http://web.example"], allowNoOrigin: true }),
    hookToken: "hook",
    socketFactory: createTestMuximodSocketFactory(),
  });
  const fixture: HttpFixture = { app, statuses: {}, origins: {}, lastResponse: null, originalFetch };
  globalThis.fetch = (async (input, init) => {
    const response = await app.fetch(new Request(input, init));
    fixture.lastResponse = response
      ? { status: response.status, origin: response.headers.get("access-control-allow-origin") }
      : null;
    return response ?? new Response(null, { status: 101 });
  }) as typeof globalThis.fetch;
  return {
    fixture,
    cleanup: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const cases = [
  {
    name: "keeps public auth information public and protects capabilities",
    steps: [{ type: "health" }, { type: "info" }, { type: "protected" }, { type: "preflight" }],
    assert: [
      hasObserved<HttpContext, undefined>("statuses", { health: 200, info: 200, protected: 401, preflight: 204 }),
      hasObserved<HttpContext, undefined>("origins", {
        health: null,
        info: "http://web.example",
        protected: "http://web.example",
        preflight: "http://web.example",
      }),
    ],
  },
] satisfies readonly ScenarioCase<"default", HttpStep, undefined, HttpContext>[];

const table: ScenarioTable<HttpFixture, "default", HttpStep, undefined, HttpContext> = {
  defaultFixture: httpFixture,
  cases,
  execute: async (fixture, steps) => {
    const client = createHttpTestClient({ httpBaseUrl: "http://muximod.example", origin: "http://web.example" });
    for (const step of steps) {
      if (step.type === "health") {
        const response = await fixture.app.request("http://muximod.example/health");
        fixture.statuses.health = response.status;
        fixture.origins.health = response.headers.get("access-control-allow-origin");
        continue;
      }
      if (step.type === "info") {
        await client.authInfo();
        fixture.statuses.info = fixture.lastResponse?.status ?? 0;
        fixture.origins.info = fixture.lastResponse?.origin ?? null;
        continue;
      }
      if (step.type === "protected") {
        try {
          await client.capabilities();
          fixture.statuses.protected = 200;
        } catch (error) {
          fixture.statuses.protected =
            fixture.lastResponse?.status ??
            (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
              ? error.status
              : 0);
        }
        fixture.origins.protected = fixture.lastResponse?.origin ?? null;
        continue;
      }
      const response = await fixture.app.request(
        new Request("http://muximod.example/rpc/capabilities", {
          method: "OPTIONS",
          headers: { origin: "http://web.example", "access-control-request-method": "POST" },
        }),
      );
      fixture.statuses.preflight = response.status;
      fixture.origins.preflight = response.headers.get("access-control-allow-origin");
    }
  },
  observe: (fixture) => ({ statuses: { ...fixture.statuses }, origins: { ...fixture.origins } }),
};

describe("muximod RPC authentication boundary", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

function createApplication(): MuximodApplication {
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
