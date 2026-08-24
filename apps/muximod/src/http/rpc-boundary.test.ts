import type { CreatePaneInput, CreateSessionInput, MuximodApplication } from "@muximo/application";
import { type AuthInfo, muximodHealthSchema } from "@muximo/contract";
import { Pane, PaneId } from "@muximo/domain";
import {
  type Assertion,
  type FixtureHandle,
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { createMuximodApp, type MuximodApp, type MuximodAuthPort } from "./app.js";
import { createOriginPolicy } from "./middleware.js";
import { createHttpTestClient } from "./test-client.js";
import { createTestMuximodSocketFactory } from "./test-socket.js";

const authContext = {
  sessionId: "session-http-test-00000000",
  serverId: "server-http-test-00000000",
  deviceId: "device-http-test-00000000",
  issuedAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2099-08-15T00:00:00.000Z",
  device: {
    deviceId: "device-http-test-00000000",
    serverId: "server-http-test-00000000",
    publicKey: { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y" },
    keyFingerprint: "fingerprint-http-test",
    displayName: "HTTP test",
    deviceType: "browser" as const,
    status: "active" as const,
    createdAt: "2026-08-15T00:00:00.000Z",
    approvedAt: "2026-08-15T00:00:00.000Z",
  },
};
const workspace = {
  id: "workspace-1",
  name: "muximo",
  directory: "/work/muximo",
  isGit: true,
  setupScriptPath: null,
  cleanupScriptPath: null,
  worktreeCopyPatterns: [],
};
const session = { name: "integration", paneCount: 1, waitingCount: 0, detail: "0 agents · 1 shell" };
const pane = Pane.create({
  id: PaneId.create("pane-1"),
  hostPaneId: "%1",
  sessionName: "integration",
  windowId: "@1",
  kind: "shell",
  name: "shell",
  cwd: "/work/muximo",
  workspaceId: undefined,
  agentId: undefined,
  initialState: "running",
  title: undefined,
  lastSeenAt: "2026-08-15T00:00:00.000Z",
});

type AppFixture = {
  app: MuximodApp;
  events: Array<{ event: string; client: string }>;
  sessionInputs: CreateSessionInput[];
  paneInputs: CreatePaneInput[];
  originalFetch: typeof globalThis.fetch;
};
type HttpResult = { status: number; body: unknown; allowOrigin: string | null; vary: string | null };
type HttpContext = { events: readonly { event: string; client: string }[] };
type HttpInput =
  | { operation: "health" | "unknown" | "hook" }
  | { operation: "preflight"; origin: "allowed" | "denied" };
type RpcInput =
  | { operation: "info" | "authorized-sessions" | "unauthorized-sessions" }
  | { operation: "list-panes" }
  | {
      operation: "create-session";
      input: { name: string; workspaceId: string };
    }
  | {
      operation: "create-pane";
      input: {
        sessionName: string;
        kind: "shell";
        name: string;
        workspaceId: string;
        agentId: null;
        useWorktree: true;
        placement: "bottom";
        targetPaneId: "%1";
      };
    };
type RpcContext = {
  sessionInputs: readonly CreateSessionInput[];
  paneInputs: readonly CreatePaneInput[];
};

const responseMatches = (
  status: number,
  expectedBody?: unknown,
  schema?: { safeParse(value: unknown): { success: boolean } },
): Assertion<HttpContext, HttpResult> => ({
  name: `returns HTTP ${status}`,
  check: (_context, result) => {
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ status }) });
    if (!result.ok) return;
    if (schema) expect(schema.safeParse(result.value.body).success).toBe(true);
    if (expectedBody !== undefined) expect(result.value.body).toMatchObject(expectedBody as object);
  },
});

const appFixture =
  (ready: boolean): (() => FixtureHandle<AppFixture>) =>
  () => {
    const events: Array<{ event: string; client: string }> = [];
    const sessionInputs: CreateSessionInput[] = [];
    const paneInputs: CreatePaneInput[] = [];
    const originalFetch = globalThis.fetch;
    const app = createMuximodApp({
      auth: testAuth,
      application: createTestApplication(events, { sessionInputs, paneInputs }),
      isReady: () => ready,
      originPolicy: createOriginPolicy({ allowedOrigins: ["http://web.example"], allowNoOrigin: true }),
      hookToken: "test-token",
      socketFactory: createTestMuximodSocketFactory(),
    });
    globalThis.fetch = (async (input, init) => {
      const response = await app.fetch(new Request(input, init));
      return response ?? new Response(null, { status: 101 });
    }) as typeof globalThis.fetch;
    return {
      fixture: { app, events, sessionInputs, paneInputs, originalFetch },
      cleanup: () => {
        globalThis.fetch = originalFetch;
      },
    };
  };

const httpCases = [
  {
    name: "returns a typed health response without CORS headers",
    input: { operation: "health" },
    assert: [
      responseMatches(200, { service: "muximod", protocolVersion: 1 }, muximodHealthSchema),
      {
        name: "does not add a cross-origin header to health probes",
        check: (_context, result) => {
          if (!result.ok) throw result.error;
          expect(result.value.allowOrigin).toBe(null);
        },
      },
    ],
  },
  {
    name: "returns the shared unavailable response while starting",
    fixture: "not-ready",
    input: { operation: "health" },
    assert: [responseMatches(503, { error: "muximod_unavailable", message: "muximod is still starting" })],
  },
  {
    name: "returns the shared response for an unknown transport route",
    input: { operation: "unknown" },
    assert: [responseMatches(404, { error: "not_found", message: "Route not found" })],
  },
  {
    name: "forwards a signed tmux hook to the application port",
    input: { operation: "hook" },
    assert: [
      responseMatches(204),
      hasObserved<HttpContext, HttpResult>("events", [{ event: "client-active", client: "/dev/desktop" }]),
    ],
  },
  {
    name: "answers an allowlisted RPC preflight with an exact origin and Vary header",
    input: { operation: "preflight", origin: "allowed" },
    assert: [
      responseMatches(204),
      {
        name: "returns the configured CORS origin",
        check: (_context, result) => {
          if (!result.ok) throw result.error;
          expect(result.value.allowOrigin).toBe("http://web.example");
          expect(result.value.vary).toBe("Origin");
        },
      },
    ],
  },
  {
    name: "rejects a denied RPC preflight without CORS headers",
    input: { operation: "preflight", origin: "denied" },
    assert: [
      responseMatches(403, { error: "origin_not_allowed" }),
      {
        name: "does not reflect the denied origin",
        check: (_context, result) => {
          if (!result.ok) throw result.error;
          expect(result.value.allowOrigin).toBe(null);
          expect(result.value.vary).toBe(null);
        },
      },
    ],
  },
] satisfies readonly OperationCase<"default" | "not-ready", HttpInput, HttpResult, HttpContext>[];

const httpTable: OperationTable<AppFixture, "default" | "not-ready", HttpInput, HttpResult, HttpContext> = {
  defaultFixture: appFixture(true),
  fixtures: { default: appFixture(true), "not-ready": appFixture(false) },
  cases: httpCases,
  execute: async (fixture, input) => {
    const preflightOrigin =
      input.operation === "preflight" && input.origin === "denied" ? "http://evil.example" : "http://web.example";
    const request =
      input.operation === "health"
        ? new Request("http://muximod.local/health")
        : input.operation === "unknown"
          ? new Request("http://muximod.local/legacy/sessions")
          : input.operation === "hook"
            ? new Request("http://muximod.local/internal/tmux-hook", {
                method: "POST",
                headers: { "x-muximod-hook-token": "test-token", "content-type": "application/x-www-form-urlencoded" },
                body: "event=client-active&client=%2Fdev%2Fdesktop",
              })
            : new Request("http://muximod.local/rpc/sessions/list", {
                method: "OPTIONS",
                headers: {
                  origin: preflightOrigin,
                  "access-control-request-method": "POST",
                },
              });
    const response = await fixture.app.request(request);
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
      allowOrigin: response.headers.get("access-control-allow-origin"),
      vary: response.headers.get("vary"),
    };
  },
  observe: (fixture) => ({ events: [...fixture.events] }),
};

const rpcCases = [
  {
    name: "keeps public auth information available through oRPC",
    input: { operation: "info" },
    assert: [
      {
        name: "returns a protocol-compatible auth response",
        check: (_context, result) => {
          if (!result.ok) throw result.error;
          const value = result.value as AuthInfo;
          expect(value.protocolVersion).toBe(1);
          expect(value.serverId).toBe(authContext.serverId);
        },
      },
    ],
  },
  {
    name: "allows an authenticated session query through oRPC",
    input: { operation: "authorized-sessions" },
    assert: [returns<RpcContext, unknown>([session])],
  },
  {
    name: "maps the application host pane identity to the stable wire field",
    input: { operation: "list-panes" },
    assert: [
      {
        name: "returns tmuxPaneId without leaking hostPaneId",
        check: (_context, result) => {
          if (!result.ok) throw result.error;
          const panes = result.value as Array<Record<string, unknown>>;
          expect(panes).toEqual([expect.objectContaining({ tmuxPaneId: "%1" })]);
          expect(panes[0]).not.toHaveProperty("hostPaneId");
        },
      },
    ],
  },
  {
    name: "rejects a protected session query without a bearer token",
    input: { operation: "unauthorized-sessions" },
    assert: [hasError<RpcContext, unknown>({ status: 401, message: "Bearer authentication is required" })],
  },
  {
    name: "passes session workspace selection to one application usecase",
    input: { operation: "create-session", input: { name: "integration", workspaceId: "workspace-1" } },
    assert: [
      {
        name: "keeps workspace resolution inside the application",
        check: (context, result) => {
          if (!result.ok) throw result.error;
          expect(context.sessionInputs).toEqual([{ name: "integration", workspaceId: "workspace-1" }]);
        },
      },
    ],
  },
  {
    name: "passes pane workspace and worktree policy inputs to one application usecase",
    input: {
      operation: "create-pane",
      input: {
        sessionName: "integration",
        kind: "shell",
        name: "shell",
        workspaceId: "workspace-1",
        agentId: null,
        useWorktree: true,
        placement: "bottom",
        targetPaneId: "%1",
      },
    },
    assert: [
      {
        name: "keeps pane selection and worktree resolution inside the application",
        check: (context, result) => {
          if (!result.ok) throw result.error;
          expect(context.paneInputs).toEqual([
            {
              sessionName: "integration",
              kind: "shell",
              name: "shell",
              workspaceId: "workspace-1",
              agentId: null,
              useWorktree: true,
              placement: "bottom",
              targetPaneId: "%1",
            },
          ]);
        },
      },
    ],
  },
] satisfies readonly OperationCase<"default", RpcInput, unknown, RpcContext>[];

const rpcTable: OperationTable<AppFixture, "default", RpcInput, unknown, RpcContext> = {
  defaultFixture: appFixture(true),
  cases: rpcCases,
  execute: async (_fixture, input) => {
    const connection = {
      httpBaseUrl: "http://muximod.local",
      origin: "http://web.example",
      ...(input.operation === "authorized-sessions" ||
      input.operation === "list-panes" ||
      input.operation === "create-session" ||
      input.operation === "create-pane"
        ? { auth: { getAccessToken: async () => "test-token" } }
        : {}),
    };
    const client = createHttpTestClient(connection);
    if (input.operation === "info") return client.authInfo();
    if (input.operation === "authorized-sessions" || input.operation === "unauthorized-sessions")
      return client.sessions();
    if (input.operation === "list-panes") return client.panes();
    if (input.operation === "create-session") return client.createSession(input.input);
    if (input.operation === "create-pane") return client.createPane(input.input);
    throw new Error(`unsupported RPC test operation: ${input.operation}`);
  },
  observe: (fixture) => ({ sessionInputs: [...fixture.sessionInputs], paneInputs: [...fixture.paneInputs] }),
};

describe("muximod transport boundary", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, httpTable);
  runOperationTable(register, rpcTable);
});

const testAuth: MuximodAuthPort = {
  serverId: authContext.serverId,
  authenticateAccessToken: async (token) => (token === "test-token" ? authContext : undefined),
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

function createTestApplication(
  events: Array<{ event: string; client: string }>,
  calls: { sessionInputs: CreateSessionInput[]; paneInputs: CreatePaneInput[] },
): MuximodApplication {
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
      list: async () => [workspace],
      browse: async () => [workspace],
      register: async () => workspace,
      update: async () => workspace,
      delete: async () => undefined,
    },
    sessions: {
      list: async () => [session],
      create: async (input) => {
        calls.sessionInputs.push(input);
        return session;
      },
    },
    panes: {
      list: async () => [pane],
      create: async (input) => {
        calls.paneInputs.push(input);
        return pane;
      },
    },
    hooks: {
      handleTerminalHostHook: async (event, client) => {
        events.push({ event, client });
      },
    },
  };
}
