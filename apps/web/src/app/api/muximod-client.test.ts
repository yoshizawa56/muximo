import { muximodContract } from "@muximo/contract/api";
import { protocolVersion } from "@muximo/contract/shared";
import {
  type FixtureHandle,
  hasError,
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { implement, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { describe, it } from "vitest";
import {
  createSameOriginConnection,
  createServeConnection,
  type MuximodConnection,
  muximodRpc,
} from "./muximod-client.js";

const workspace = {
  id: "workspace-1",
  name: "muximo",
  directory: "/work/muximo",
  isGit: true,
  setupScriptPath: null,
  cleanupScriptPath: null,
};
const session = { name: "integration", paneCount: 1, waitingCount: 0, detail: "0 agents · 1 shell", managed: true };
const agentSession = {
  id: "agent-session-1",
  name: "integration-agent",
  backend: "codex" as const,
  status: "exited" as const,
  workspaceId: "workspace-1",
  workspaceRoot: "/work/muximo",
  workspaceName: "muximo",
  useWorktree: false,
  setupRan: false,
  resuming: false,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};
const pane = {
  id: "pane-1",
  hostPaneId: "%0",
  sessionName: "integration",
  windowId: "@0",
  kind: "shell" as const,
  name: "shell",
  cwd: "/tmp",
  workspaceId: null,
  agentId: null,
  state: "running" as const,
  title: null,
  lastSeenAt: "2026-08-15T00:00:00.000Z",
};

type RpcOperation =
  | "sessions"
  | "panes"
  | "workspaces"
  | "browse-workspaces"
  | "invalid-session"
  | "manage-session"
  | "update-workspace"
  | "delete-workspace";
type RpcInput = {
  operation: RpcOperation;
  path: string;
  workspaceId?: string;
  sessionName?: string;
};
type RpcRequest = { method: string; url: string };
type RpcBehavior = { failure: RpcOperation | null };
type RpcFixture = {
  handler: RPCHandler<Record<never, never>>;
  behavior: RpcBehavior;
  requests: RpcRequest[];
  originalFetch: typeof globalThis.fetch;
};
type RpcContext = { requests: readonly RpcRequest[] };

const rpcFixture = (): FixtureHandle<RpcFixture> => {
  const originalFetch = globalThis.fetch;
  const behavior: RpcBehavior = { failure: null };
  const fixture: RpcFixture = {
    handler: createRpcHandler(behavior),
    behavior,
    requests: [],
    originalFetch,
  };
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    fixture.requests.push({ method: request.method, url: request.url });
    const result = await fixture.handler.handle(request, { prefix: "/rpc", context: {} });
    return result.matched
      ? result.response
      : new Response(JSON.stringify({ error: "not_found", message: "Route not found" }), { status: 404 });
  };
  return {
    fixture,
    cleanup: () => {
      globalThis.fetch = fixture.originalFetch;
    },
  };
};

const rpcCases = [
  {
    name: "reads sessions through the typed RPC procedure",
    input: { operation: "sessions", path: "/rpc/sessions/list" },
    assert: [
      returns<RpcContext, unknown>([session]),
      hasObserved<RpcContext, unknown>("requests", [{ method: "POST", url: "http://muximod.local/rpc/sessions/list" }]),
    ],
  },
  {
    name: "reads panes through the typed RPC procedure",
    input: { operation: "panes", path: "/rpc/panes/list", sessionName: "integration" },
    assert: [
      returns<RpcContext, unknown>([pane]),
      hasObserved<RpcContext, unknown>("requests", [{ method: "POST", url: "http://muximod.local/rpc/panes/list" }]),
    ],
  },
  {
    name: "reads workspaces through the typed RPC procedure",
    input: { operation: "workspaces", path: "/rpc/workspaces/list" },
    assert: [
      returns<RpcContext, unknown>([workspace]),
      hasObserved<RpcContext, unknown>("requests", [
        { method: "POST", url: "http://muximod.local/rpc/workspaces/list" },
      ]),
    ],
  },
  {
    name: "browses host directories through the typed RPC procedure",
    input: { operation: "browse-workspaces", path: "/rpc/workspaces/browse" },
    assert: [
      returns<RpcContext, unknown>([workspace]),
      hasObserved<RpcContext, unknown>("requests", [
        { method: "POST", url: "http://muximod.local/rpc/workspaces/browse" },
      ]),
    ],
  },
  {
    name: "maps structured RPC errors to the client error boundary",
    input: { operation: "invalid-session", path: "/rpc/sessions/list" },
    assert: [
      hasError<RpcContext, unknown>({
        code: "invalid_directory",
        message: "Directory is outside the allowed workspace roots",
        details: { reason: "outside_allowed_root" },
      }),
      hasObserved<RpcContext, unknown>("requests", [{ method: "POST", url: "http://muximod.local/rpc/sessions/list" }]),
    ],
  },
] satisfies readonly OperationCase<"default", RpcInput, unknown, RpcContext>[];

const rpcTable: OperationTable<RpcFixture, "default", RpcInput, unknown, RpcContext> = {
  defaultFixture: rpcFixture,
  cases: rpcCases,
  execute: async (fixture, input) => {
    fixture.behavior.failure = input.operation === "invalid-session" ? input.operation : null;
    const rpc = muximodRpc({ httpBaseUrl: "http://muximod.local", websocketUrl: "ws://muximod.local/terminal" });
    if (input.operation === "sessions" || input.operation === "invalid-session")
      return (await rpc.sessions.list({})).sessions;
    if (input.operation === "panes")
      return (await rpc.panes.list(input.sessionName ? { session: input.sessionName } : {})).panes;
    if (input.operation === "workspaces") return (await rpc.workspaces.list({})).workspaces;
    return (await rpc.workspaces.browse({})).directories;
  },
  observe: (fixture) => ({ requests: [...fixture.requests] }),
};

const mutationCases = [
  {
    name: "adopts an existing session through the typed RPC procedure",
    input: { operation: "manage-session", path: "/rpc/sessions/manage", sessionName: "integration" },
    assert: [
      returns<RpcContext, unknown>({ name: "integration", changed: true }),
      hasObserved<RpcContext, unknown>("requests", [
        { method: "POST", url: "http://muximod.local/rpc/sessions/manage" },
      ]),
    ],
  },
  {
    name: "updates a workspace through the typed RPC procedure",
    input: { operation: "update-workspace", path: "/rpc/workspaces/update", workspaceId: "workspace-1" },
    assert: [
      returns<RpcContext, unknown>({ ...workspace, name: "renamed" }),
      hasObserved<RpcContext, unknown>("requests", [
        { method: "POST", url: "http://muximod.local/rpc/workspaces/update" },
      ]),
    ],
  },
  {
    name: "deletes a workspace through the typed RPC procedure",
    input: { operation: "delete-workspace", path: "/rpc/workspaces/delete", workspaceId: "workspace-1" },
    assert: [
      returns<RpcContext, unknown>(undefined),
      hasObserved<RpcContext, unknown>("requests", [
        { method: "POST", url: "http://muximod.local/rpc/workspaces/delete" },
      ]),
    ],
  },
] satisfies readonly OperationCase<"default", RpcInput, unknown, RpcContext>[];

const mutationTable: OperationTable<RpcFixture, "default", RpcInput, unknown, RpcContext> = {
  defaultFixture: rpcFixture,
  cases: mutationCases,
  execute: async (_fixture, input) => {
    const rpc = muximodRpc({ httpBaseUrl: "http://muximod.local", websocketUrl: "ws://muximod.local/terminal" });
    if (input.operation === "manage-session") return (await rpc.sessions.manage({ name: input.sessionName! })).session;
    if (input.operation === "update-workspace")
      return (await rpc.workspaces.update({ workspaceId: input.workspaceId!, input: { name: "renamed" } })).workspace;
    await rpc.workspaces.delete({ workspaceId: input.workspaceId! });
    return undefined;
  },
  observe: (fixture) => ({ requests: [...fixture.requests] }),
};

type RouteInput = { kind: "serve" | "same-origin"; url: string };
const routeCases = [
  {
    name: "builds a Serve HTTPS and WSS pair",
    input: { kind: "serve", url: "https://workstation.tailnet.ts.net/" },
    assert: [
      returns<{}, MuximodConnection>({
        httpBaseUrl: "https://workstation.tailnet.ts.net",
        websocketUrl: "wss://workstation.tailnet.ts.net/terminal",
        route: "serve",
      }),
    ],
  },
  {
    name: "preserves a reverse proxy path",
    input: { kind: "serve", url: "https://example.test/muximod/" },
    assert: [
      returns<{}, MuximodConnection>({
        httpBaseUrl: "https://example.test/muximod",
        websocketUrl: "wss://example.test/muximod/terminal",
        route: "serve",
      }),
    ],
  },
  {
    name: "builds a same-origin development route",
    input: { kind: "same-origin", url: "http://localhost:5173" },
    assert: [
      returns<{}, MuximodConnection>({
        httpBaseUrl: "http://localhost:5173",
        websocketUrl: "ws://localhost:5173/terminal",
        route: "same-origin",
      }),
    ],
  },
  {
    name: "rejects a non-http route URL",
    input: { kind: "serve", url: "ssh://workstation" },
    assert: [hasError<{}, MuximodConnection>({ message: /^muximod URL must use http or https/ })],
  },
] satisfies readonly OperationCase<"default", RouteInput, MuximodConnection, {}>[];

const routeTable: OperationTable<undefined, "default", RouteInput, MuximodConnection, {}> = {
  defaultFixture: noFixture(),
  cases: routeCases,
  execute: (_fixture, input) =>
    input.kind === "serve" ? createServeConnection(input.url) : createSameOriginConnection(input.url),
  observe: () => ({}),
};

describe("muximod RPC client", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, rpcTable);
  runOperationTable(register, mutationTable);
  runOperationTable(register, routeTable);
});

function createRpcHandler(behavior: RpcBehavior): RPCHandler<Record<never, never>> {
  const os = implement(muximodContract).$context<Record<never, never>>();
  return new RPCHandler(
    os.router({
      health: os.health.handler(() => ({
        ok: true,
        service: "muximod",
        protocolVersion,
        pid: process.pid,
        configurationFingerprint: "0".repeat(64),
      })),
      capabilities: os.capabilities.handler(() => ({
        protocolVersion,
        features: { tmuxSessions: true, terminalWebSocket: true, paneState: true, resourceInvalidationEvents: true },
      })),
      auth: {
        info: os.auth.info.handler(() => ({
          protocolVersion,
          serverId: "server-test-00000000",
          serverTime: "2026-08-15T00:00:00.000Z",
        })),
        claimPairing: os.auth.claimPairing.handler(() => ({
          serverId: "server-test-00000000",
          pairingId: "pairing-test-00000000",
          claimToken: "claim-token-00000000000000000000000000000000",
          status: "awaiting_approval",
          expiresAt: "2026-08-15T00:00:00.000Z",
          keyFingerprint: "fingerprint",
        })),
        pairingStatus: os.auth.pairingStatus.handler(() => ({ status: "approved", deviceId: "device-test" })),
        createChallenge: os.auth.createChallenge.handler(() => ({
          serverId: "server-test-00000000",
          deviceId: "device-test",
          challengeId: "challenge-test-00000000",
          nonce: "nonce-00000000000000",
          expiresAt: "2026-08-15T00:00:00.000Z",
        })),
        createSession: os.auth.createSession.handler(() => ({
          serverId: "server-test-00000000",
          deviceId: "device-test",
          sessionId: "session-test-00000000",
          accessToken: "access-token-00000000000000000000000000000000",
          expiresAt: "2026-08-15T00:00:00.000Z",
        })),
        issueWebSocketTicket: os.auth.issueWebSocketTicket.handler(() => ({
          ticket: "ticket-00000000000000000000000000000000",
          endpoint: "terminal",
          expiresAt: "2026-08-15T00:00:00.000Z",
        })),
      },
      workspaces: {
        list: os.workspaces.list.handler(() => ({ workspaces: [workspace] })),
        browse: os.workspaces.browse.handler(() => ({ directories: [workspace] })),
        register: os.workspaces.register.handler(() => ({ workspace })),
        update: os.workspaces.update.handler(() => ({ workspace: { ...workspace, name: "renamed" } })),
        delete: os.workspaces.delete.handler(() => ({})),
      },
      terminals: {
        list: os.terminals.list.handler(() => ({
          terminals: [
            {
              id: "terminal",
              name: "terminal",
              host: "host",
              tailnetIp: "100.64.0.1",
              state: "online",
              detail: "test",
              lastSeen: "now",
            },
          ],
        })),
      },
      sessions: {
        list: os.sessions.list.handler(() => {
          if (behavior.failure === "invalid-session") {
            throw new ORPCError("BAD_REQUEST", {
              message: "Directory is outside the allowed workspace roots",
              data: {
                code: "invalid_directory",
                details: { directory: "/private/secret", reason: "outside_allowed_root" },
              },
            });
          }
          return { sessions: [session] };
        }),
        create: os.sessions.create.handler(() => ({ session })),
        manage: os.sessions.manage.handler(() => ({ session: { name: session.name, changed: true } })),
      },
      panes: {
        list: os.panes.list.handler(() => ({ panes: [pane] })),
        create: os.panes.create.handler(() => ({ pane })),
      },
      agentSessions: {
        cleanup: os.agentSessions.cleanup.handler(() => ({
          session: agentSession,
          cleanup: { disposition: "removed" },
        })),
        list: os.agentSessions.list.handler(() => ({
          allViews: [
            {
              session: agentSession,
              executionHealth: "inactive",
              resume: "unavailable",
              resumeReason: "not_resumable_state",
              worktreeState: "not_applicable",
              visibleByDefault: true,
            },
          ],
          views: [],
        })),
      },
      events: {
        subscribe: os.events.subscribe.handler(async function* () {}),
      },
    }),
  );
}
