import { describe, expect, it } from "vitest";
import { Workspace, WorkspaceId } from "@muximo/domain";
import type { MuximodApplication } from "@muximo/application";
import { createHttpTestClient } from "./test-client.js";
import {
  hasError,
  hasObserved,
  returns,
  runOperationTable,
  type Assertion,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { muximodHealthSchema, type AuthInfo } from "@muximo/contract";
import { createMuximodApp, type MuximodApp, type MuximodAuthPort } from "./app.js";

const authContext = {
  sessionId: "session-http-test-00000000",
  serverId: "server-http-test-00000000",
  deviceId: "device-http-test-00000000",
  issuedAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2099-08-15T00:00:00.000Z",
  revokedAt: null,
  device: {
    deviceId: "device-http-test-00000000",
    serverId: "server-http-test-00000000",
    publicKeyJwk: "{}",
    keyFingerprint: "fingerprint-http-test",
    displayName: "HTTP test",
    deviceType: "browser" as const,
    platform: null,
    clientVersion: null,
    status: "active" as const,
    createdAt: "2026-08-15T00:00:00.000Z",
    approvedAt: "2026-08-15T00:00:00.000Z",
    lastSeenAt: null,
    revokedAt: null,
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
const workspaceRecord = Workspace.create({
  id: WorkspaceId.create(workspace.id),
  rootPath: workspace.directory,
  name: workspace.name,
  isGit: workspace.isGit,
  worktreeCopyPatterns: workspace.worktreeCopyPatterns,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
});
const session = { name: "integration", paneCount: 1, waitingCount: 0, detail: "0 agents · 1 shell" };

type AppFixture = {
  app: MuximodApp;
  events: Array<{ event: string; client: string }>;
  originalFetch: typeof globalThis.fetch;
};
type HttpResult = { status: number; body: unknown; allowOrigin: string | null };
type HttpContext = { events: readonly { event: string; client: string }[] };
type HttpInput = { operation: "health" | "unknown" | "hook" | "preflight" };
type RpcInput = { operation: "info" | "authorized-sessions" | "unauthorized-sessions" };
type RpcContext = {};

const responseMatches = (status: number, expectedBody?: unknown, schema?: { safeParse(value: unknown): { success: boolean } }): Assertion<HttpContext, HttpResult> => ({
  name: `returns HTTP ${status}`,
  check: (_context, result) => {
    expect(result).toEqual({ ok: true, value: expect.objectContaining({ status }) });
    if (!result.ok) return;
    if (schema) expect(schema.safeParse(result.value.body).success).toBe(true);
    if (expectedBody !== undefined) expect(result.value.body).toMatchObject(expectedBody as object);
  },
});

const appFixture = (ready: boolean): (() => FixtureHandle<AppFixture>) => () => {
  const events: Array<{ event: string; client: string }> = [];
  const originalFetch = globalThis.fetch;
  const app = createMuximodApp({
    auth: testAuth,
    application: createTestApplication(events),
    isReady: () => ready,
    corsOrigin: "http://web.example",
    hookToken: "test-token",
  });
  globalThis.fetch = (async (input, init) => {
    const response = await app.fetch(new Request(input, init));
    return response ?? new Response(null, { status: 101 });
  }) as typeof globalThis.fetch;
  return {
    fixture: { app, events, originalFetch },
    cleanup: () => { globalThis.fetch = originalFetch; },
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
    assert: [responseMatches(204), hasObserved<HttpContext, HttpResult>("events", [{ event: "client-active", client: "/dev/desktop" }])],
  },
  {
    name: "answers RPC preflight requests at the transport boundary",
    input: { operation: "preflight" },
    assert: [
      responseMatches(204),
      {
        name: "returns the configured CORS origin",
        check: (_context, result) => {
          if (!result.ok) throw result.error;
          expect(result.value.allowOrigin).toBe("http://web.example");
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
    const request = input.operation === "health"
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
            headers: { origin: "http://web.example", "access-control-request-method": "POST" },
          });
    const response = await fixture.app.request(request);
    return {
      status: response.status,
      body: response.status === 204 ? null : await response.json(),
      allowOrigin: response.headers.get("access-control-allow-origin"),
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
    name: "rejects a protected session query without a bearer token",
    input: { operation: "unauthorized-sessions" },
    assert: [hasError<RpcContext, unknown>({ status: 401, message: "Bearer authentication is required" })],
  },
] satisfies readonly OperationCase<"default", RpcInput, unknown, RpcContext>[];

const rpcTable: OperationTable<AppFixture, "default", RpcInput, unknown, RpcContext> = {
  defaultFixture: appFixture(true),
  cases: rpcCases,
  execute: async (fixture, input) => {
    const connection = {
      httpBaseUrl: "http://muximod.local",
      ...(input.operation === "authorized-sessions"
        ? { auth: { getAccessToken: async () => "test-token" } }
        : {}),
    };
    const client = createHttpTestClient(connection);
    if (input.operation === "info") return client.authInfo();
    return client.sessions();
  },
  observe: () => ({}),
};

describe("muximod transport boundary", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, httpTable);
  runOperationTable(register, rpcTable);
});

const testAuth: MuximodAuthPort = {
  serverId: authContext.serverId,
  authenticateAccessToken: (token) => token === "test-token" ? authContext : null,
  claimPairing: () => { throw new Error("not used"); },
  pairingStatus: () => { throw new Error("not used"); },
  createChallenge: () => { throw new Error("not used"); },
  createSession: () => { throw new Error("not used"); },
  issueWebSocketTicket: () => { throw new Error("not used"); },
  consumeWebSocketTicket: () => null,
};

function createTestApplication(events: Array<{ event: string; client: string }>): MuximodApplication {
  return {
    terminal: { get: async () => ({ id: "terminal", name: "terminal", host: "host", tailnetIp: "100.64.0.1", state: "online", detail: "test", lastSeen: "now" }) },
    workspaces: {
      list: async () => [workspace],
      browse: async () => [workspace],
      register: async () => workspace,
      update: async () => workspace,
      delete: async () => undefined,
      resolveDirectory: async () => workspaceRecord,
      resolveSelection: async () => workspaceRecord,
    },
    sessions: { list: async () => [session], create: async () => session },
    panes: { list: async () => [], create: async () => { throw new Error("not used"); } },
    hooks: { handleTmux: (event, client) => events.push({ event, client }) },
  };
}
