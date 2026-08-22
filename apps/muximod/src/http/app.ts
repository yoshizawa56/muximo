import { ORPCError, implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { muximodContract } from "@muximo/contract";
import type {
  AuthPairingClaimRequest as ApplicationAuthPairingClaimRequest,
  CreatePaneInput,
  MuximodPaneSummary,
  MuximodSessionSummary,
  MuximodTerminalEndpoint,
  MuximodWorkspaceDirectory,
  RegisterWorkspaceCommand,
  UpdateWorkspaceCommand,
} from "@muximo/application";
import type { MuximodAuthContext } from "@muximo/application";
import { clearPatch, type Patch } from "@muximo/domain";
import {
  authInfoSchema,
  muximodCapabilitiesSchema,
  muximodHealthSchema,
  pairingClaimRequestSchema,
  pairingStatusSchema,
  paneSummarySchema,
  type CreatePaneRequest,
  type RegisterWorkspaceRequest,
  type UpdateWorkspaceRequest,
} from "@muximo/contract";
import { z } from "zod";
import { BunSocketAdapter } from "@muximo/infrastructure";
import type {
  MuximodAuthContext as HttpAuthContext,
  MuximodHttpDependencies,
  MuximodHttpStatus,
  MuximodHookEvent,
} from "./types.js";
import type { ServerWebSocket, WebSocketHandler } from "bun";

export class MuximodHttpError extends Error {
  public constructor(
    public readonly status: MuximodHttpStatus,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MuximodHttpError";
  }
}

export type MuximodRpcContext = {
  auth: HttpAuthContext | null;
  pairingToken?: string;
};

export type MuximodWebSocketData = {
  endpoint: "terminal";
  context: HttpAuthContext;
  socket?: BunSocketAdapter;
};

type UpgradeServer = {
  upgrade(request: Request, options: { data: MuximodWebSocketData }): boolean;
};

type MuximodFetchApp = {
  fetch(request: Request, server?: UpgradeServer): Promise<Response | undefined>;
  request(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  websocket: WebSocketHandler<MuximodWebSocketData> & { idleTimeout: number };
};

export function createMuximodApp(deps: MuximodHttpDependencies): MuximodFetchApp {
  const router = createMuximodRouter(deps);
  const handler = new RPCHandler(router);

  const app: MuximodFetchApp = {
    fetch: async (request, server) => {
      const startedAt = Date.now();
      const path = new URL(request.url).pathname;
      deps.logger?.debug("http.request_started", { method: request.method, path });
      let response: Response | undefined;
      try {
        response = await handleRequest(request, server, deps, handler);
        return response;
      } catch (error) {
        response = errorResponse(error, deps.corsOrigin);
        return response;
      } finally {
        deps.logger?.debug("http.request_finished", {
          method: request.method,
          path,
          statusCode: response?.status,
          durationMs: Date.now() - startedAt,
        });
      }
    },
    request: async (input, init) => {
      const response = await app.fetch(new Request(input, init));
      return response ?? new Response(null, { status: 101 });
    },
    websocket: createWebSocketHandler(deps),
  };

  return app;
}

export type MuximodApp = ReturnType<typeof createMuximodApp>;
export type { MuximodAuthContext, MuximodAuthPort, MuximodHttpDependencies, MuximodHttpStatus, MuximodHookEvent } from "./types.js";
export { muximodSocketReadyState, BunSocketAdapter } from "@muximo/infrastructure";
export type { MuximodSocket, MuximodSocketData } from "@muximo/application";

async function handleRequest(
  request: Request,
  server: UpgradeServer | undefined,
  deps: MuximodHttpDependencies,
  handler: RPCHandler<MuximodRpcContext>,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (url.pathname === "/terminal") {
    return handleTerminalUpgrade(request, server, deps);
  }

  if (url.pathname === "/health") {
    if (request.method === "OPTIONS") return corsResponse(undefined, deps.corsOrigin, 204);
    if (deps.isReady && !deps.isReady()) {
      return jsonResponse(errorBody(new MuximodHttpError(503, "muximod_unavailable", "muximod is still starting")), 503);
    }
    return jsonResponse(muximodHealthSchema.parse({ ok: true, service: "muximod", protocolVersion: 1 }));
  }

  if (url.pathname === "/internal/tmux-hook") {
    return handleTmuxHook(request, deps);
  }

  if (url.pathname === "/rpc" || url.pathname.startsWith("/rpc/")) {
    if (request.method === "OPTIONS") return corsResponse(undefined, deps.corsOrigin, 204);
    const result = await handler.handle(request, {
      prefix: "/rpc",
      context: contextForRequest(request, deps),
    });
    return result.matched ? withCors(result.response, deps.corsOrigin) : notFound(deps.corsOrigin);
  }

  return notFound(deps.corsOrigin);
}

function createMuximodRouter(deps: MuximodHttpDependencies) {
  const os = implement(muximodContract).$context<MuximodRpcContext>();

  return os.router({
    health: os.health.handler(() => safeCall(() => {
      if (deps.isReady && !deps.isReady()) {
        throw new MuximodHttpError(503, "muximod_unavailable", "muximod is still starting");
      }
      return muximodHealthSchema.parse({
        ok: true,
        service: "muximod",
        protocolVersion: 1,
      });
    })),
    capabilities: os.capabilities.handler(({ context }) => {
      requireAuth(context);
      return muximodCapabilitiesSchema.parse({
        protocolVersion: 1,
        features: {
          tmuxSessions: true,
          terminalWebSocket: true,
          paneState: true,
          resourceInvalidationEvents: true,
        },
      });
    }),
    auth: {
      info: os.auth.info.handler(() => authInfoSchema.parse({
        protocolVersion: 1,
        serverId: deps.auth.serverId,
        serverTime: new Date().toISOString(),
      })),
      claimPairing: os.auth.claimPairing.handler(({ input }) => safeCall(() => {
        const response = deps.auth.claimPairing(input.pairingId, toApplicationPairingClaim(input.request));
        return response;
      })),
      pairingStatus: os.auth.pairingStatus.handler(({ input, context }) => safeCall(() => {
        const claimToken = context.pairingToken;
        if (!claimToken) throw new MuximodHttpError(401, "claim_token_required", "Pairing authorization is required");
        return pairingStatusSchema.parse(deps.auth.pairingStatus(input.pairingId, claimToken));
      })),
      createChallenge: os.auth.createChallenge.handler(({ input }) => safeCall(() => deps.auth.createChallenge(input.deviceId))),
      createSession: os.auth.createSession.handler(({ input }) => safeCall(() => deps.auth.createSession({
        deviceId: input.deviceId,
        challengeId: input.challengeId,
        signature: input.signature,
      }))),
      issueWebSocketTicket: os.auth.issueWebSocketTicket.handler(({ input, context }) => safeCall(() => {
        return deps.auth.issueWebSocketTicket(requireAuth(context), input.endpoint);
      })),
    },
    workspaces: {
      list: os.workspaces.list.handler(({ context }) => safeAsyncCall(async () => ({
        workspaces: (await deps.application.workspaces.list()).map(toProtocolWorkspaceDirectory),
      }), context)),
      browse: os.workspaces.browse.handler(({ input, context }) => safeAsyncCall(async () => ({
        directories: (await deps.application.workspaces.browse(input.path)).map(toProtocolWorkspaceDirectory),
      }), context)),
      register: os.workspaces.register.handler(({ input, context }) => safeAsyncCall(async () => ({
        workspace: toProtocolWorkspaceDirectory(await deps.application.workspaces.register(toApplicationRegisterWorkspace(input))),
      }), context)),
      update: os.workspaces.update.handler(({ input, context }) => safeAsyncCall(async () => ({
        workspace: toProtocolWorkspaceDirectory(await deps.application.workspaces.update(input.workspaceId, toApplicationUpdateWorkspace(input.input))),
      }), context)),
      delete: os.workspaces.delete.handler(({ input, context }) => safeAsyncCall(async () => {
        await deps.application.workspaces.delete(input.workspaceId);
        return {};
      }, context)),
    },
    terminals: {
      list: os.terminals.list.handler(({ context }) => safeAsyncCall(async () => ({
        terminals: [toProtocolTerminal(await deps.application.terminal.get())],
      }), context)),
    },
    sessions: {
      list: os.sessions.list.handler(({ context }) => safeAsyncCall(async () => ({
        sessions: (await deps.application.sessions.list()).map(toProtocolSession),
      }), context)),
      create: os.sessions.create.handler(({ input, context }) => safeAsyncCall(async () => {
        const workspace = input.workspaceId ? await deps.application.workspaces.resolveDirectory(input.workspaceId) : undefined;
        const session = await deps.application.sessions.create({
          name: input.name,
          initialCwd: workspace?.rootPath ?? input.cwd!,
        });
        return { session: toProtocolSession(session) };
      }, context)),
    },
    panes: {
      list: os.panes.list.handler(({ input, context }) => safeAsyncCall(async () => ({
        panes: (await deps.application.panes.list(input.session)).map(toProtocolPane),
      }), context)),
      create: os.panes.create.handler(({ input, context }) => safeAsyncCall(async () => {
        const workspace = input.workspaceId
          ? await deps.application.workspaces.resolveSelection({ workspaceId: input.workspaceId, mode: input.useWorktree ? "worktree" : "workspace" })
          : undefined;
        return {
          pane: toProtocolPane(await deps.application.panes.create(toApplicationCreatePane(input), workspace)),
        };
      }, context)),
    },
    events: {
      subscribe: os.events.subscribe.handler(({ signal, context }) => {
        requireAuth(context);
        if (!deps.subscribeEvents) return emptyEvents();
        return deps.subscribeEvents(signal ?? new AbortController().signal);
      }),
    },
  });
}

function createWebSocketHandler(deps: MuximodHttpDependencies): WebSocketHandler<MuximodWebSocketData> & { idleTimeout: number } {
  return {
    data: {} as MuximodWebSocketData,
    idleTimeout: 0,
    open: (ws) => {
      const socket = new BunSocketAdapter(ws);
      ws.data.socket = socket;
      deps.onTerminalConnection?.(socket, ws.data.context);
    },
    message: (ws, message) => {
      ws.data.socket?.receive(message);
    },
    close: (ws) => {
      ws.data.socket?.receiveClose();
    },
  };
}

async function handleTerminalUpgrade(request: Request, server: UpgradeServer | undefined, deps: MuximodHttpDependencies): Promise<Response | undefined> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return corsResponse({ error: "upgrade_required", message: "WebSocket upgrade is required" }, deps.corsOrigin, 426);
  }
  if (!server) return corsResponse({ error: "server_unavailable", message: "WebSocket server is unavailable" }, deps.corsOrigin, 503);

  const ticket = new URL(request.url).searchParams.get("ticket") ?? undefined;
  const context = deps.auth.consumeWebSocketTicket(ticket, "terminal");
  if (!context) return corsResponse({ error: "unauthorized", message: "WebSocket authentication is required" }, deps.corsOrigin, 401);

  if (server.upgrade(request, { data: { endpoint: "terminal", context } })) return undefined;
  return corsResponse({ error: "upgrade_failed", message: "WebSocket upgrade failed" }, deps.corsOrigin, 500);
}

async function handleTmuxHook(request: Request, deps: MuximodHttpDependencies): Promise<Response> {
  if (request.method !== "POST") return corsResponse(undefined, deps.corsOrigin, 405);
  if (request.headers.get("x-muximod-hook-token") !== deps.hookToken) {
    return corsResponse(errorBody(new MuximodHttpError(401, "unauthorized", "Invalid tmux hook token")), deps.corsOrigin, 401);
  }
  const form = await request.formData();
  const parsed = z.object({
    event: z.enum(["client-attached", "client-active", "client-resized", "client-focus-in", "client-detached"]),
    client: z.string().trim().min(1).max(256),
  }).strict().safeParse({ event: form.get("event"), client: form.get("client") });
  if (!parsed.success) return corsResponse({ error: "invalid_request", message: "Request validation failed" }, deps.corsOrigin, 400);
  deps.application.hooks.handleTmux(parsed.data.event as MuximodHookEvent, parsed.data.client);
  return corsResponse(undefined, deps.corsOrigin, 204);
}

function contextForRequest(request: Request, deps: MuximodHttpDependencies): MuximodRpcContext {
  const authorization = request.headers.get("authorization");
  const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : undefined;
  return {
    auth: deps.auth.authenticateAccessToken(token || undefined),
    pairingToken: request.headers.get("x-muximod-pairing-token") ?? undefined,
  };
}

function requireAuth(context: MuximodRpcContext): HttpAuthContext {
  if (!context.auth) throw new ORPCError("UNAUTHORIZED", { message: "Bearer authentication is required" });
  return context.auth;
}

function safeCall<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw toRpcError(error);
  }
}

async function safeAsyncCall<T>(operation: () => Promise<T>, context: MuximodRpcContext): Promise<T> {
  requireAuth(context);
  try {
    return await operation();
  } catch (error) {
    throw toRpcError(error);
  }
}

function toRpcError(error: unknown): ORPCError<string, { code: string; details?: Record<string, unknown> }> {
  if (error instanceof ORPCError) return error as ORPCError<string, { code: string; details?: Record<string, unknown> }>;
  const mapped = mapError(error);
  return new ORPCError(rpcCode(mapped.status), {
    message: mapped.message,
    data: { code: mapped.code, ...(mapped.details ? { details: mapped.details } : {}) },
  });
}

function rpcCode(status: MuximodHttpStatus): "BAD_REQUEST" | "UNAUTHORIZED" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "TOO_MANY_REQUESTS" | "SERVICE_UNAVAILABLE" {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "TOO_MANY_REQUESTS";
  if (status === 503) return "SERVICE_UNAVAILABLE";
  return "BAD_REQUEST";
}

function toApplicationCreatePane(input: CreatePaneRequest): CreatePaneInput {
  return {
    sessionName: input.sessionName,
    kind: input.kind,
    name: input.name,
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
    agentId: input.agentId,
    useWorktree: input.useWorktree,
    placement: input.placement,
    targetPaneId: input.targetPaneId,
  };
}

function toApplicationPairingClaim(input: z.infer<typeof pairingClaimRequestSchema>): ApplicationAuthPairingClaimRequest {
  return {
    pairingSecret: input.pairingSecret,
    publicKey: input.publicKey,
    deviceName: input.deviceName,
    deviceType: input.deviceType,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
    ...(input.clientVersion === undefined ? {} : { clientVersion: input.clientVersion }),
    clientNonce: input.clientNonce,
    signature: input.signature,
  };
}

function toApplicationRegisterWorkspace(input: RegisterWorkspaceRequest): RegisterWorkspaceCommand {
  return {
    directory: input.directory,
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.setupScriptPath === undefined ? {} : { setupScriptPath: toApplicationPatch(input.setupScriptPath) }),
    ...(input.cleanupScriptPath === undefined ? {} : { cleanupScriptPath: toApplicationPatch(input.cleanupScriptPath) }),
    ...(input.worktreeCopyPatterns === undefined ? {} : { worktreeCopyPatterns: input.worktreeCopyPatterns }),
  };
}

function toApplicationUpdateWorkspace(input: UpdateWorkspaceRequest): UpdateWorkspaceCommand {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.setupScriptPath === undefined ? {} : { setupScriptPath: toApplicationPatch(input.setupScriptPath) }),
    ...(input.cleanupScriptPath === undefined ? {} : { cleanupScriptPath: toApplicationPatch(input.cleanupScriptPath) }),
    ...(input.worktreeCopyPatterns === undefined ? {} : { worktreeCopyPatterns: input.worktreeCopyPatterns }),
    ...(input.appendWorktreeCopyPatterns === undefined ? {} : { appendWorktreeCopyPatterns: input.appendWorktreeCopyPatterns }),
    ...(input.clearWorktreeCopyPatterns === undefined ? {} : { clearWorktreeCopyPatterns: input.clearWorktreeCopyPatterns }),
  };
}

function toProtocolWorkspaceDirectory(value: MuximodWorkspaceDirectory) {
  return { ...value };
}

function toProtocolTerminal(value: MuximodTerminalEndpoint) {
  return { ...value };
}

function toProtocolSession(value: MuximodSessionSummary) {
  return { ...value };
}

function toProtocolPane(value: MuximodPaneSummary) {
  return paneSummarySchema.parse({
    id: value.id,
    tmuxPaneId: value.tmuxPaneId,
    sessionName: value.sessionName,
    windowId: value.windowId,
    kind: value.kind,
    name: value.name,
    cwd: value.cwd,
    workspaceId: value.workspaceId ?? null,
    agentId: value.agentId ?? null,
    state: value.state,
    title: value.title ?? null,
    ...(value.recentOutput === undefined ? {} : { recentOutput: value.recentOutput }),
    lastSeenAt: value.lastSeenAt,
    ...(value.windowName === undefined ? {} : { windowName: value.windowName }),
    ...(value.windowIndex === undefined ? {} : { windowIndex: value.windowIndex }),
    ...(value.paneIndex === undefined ? {} : { paneIndex: value.paneIndex }),
    ...(value.left === undefined ? {} : { left: value.left }),
    ...(value.top === undefined ? {} : { top: value.top }),
    ...(value.width === undefined ? {} : { width: value.width }),
    ...(value.height === undefined ? {} : { height: value.height }),
    ...(value.windowWidth === undefined ? {} : { windowWidth: value.windowWidth }),
    ...(value.windowHeight === undefined ? {} : { windowHeight: value.windowHeight }),
  });
}

function toApplicationPatch(value: string | null | undefined): Patch<string> {
  return value === null ? clearPatch : value;
}

function mapError(error: unknown): MuximodHttpError {
  if (error instanceof MuximodHttpError) return error;
  if (error instanceof z.ZodError) return new MuximodHttpError(400, "invalid_request", "Request validation failed");
  if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
    const status = errorStatus(error.code, error.status);
    const details = isRecord(error.details) ? error.details : undefined;
    return new MuximodHttpError(status, error.code, error.message, details);
  }
  return new MuximodHttpError(503, "muximod_unavailable", "muximod could not complete the request");
}

function errorStatus(code: string, status: unknown): MuximodHttpStatus {
  if (isMuximodHttpStatus(status)) return status;
  if (code === "pairing_not_found" || code === "workspace_not_found") return 404;
  if (code === "pairing_expired" || code === "claim_token_expired") return 410;
  if (code === "pairing_unavailable" || code === "pairing_not_awaiting_approval" || code === "pairing_not_rejectable" || code === "session_exists" || code === "workspace_already_registered" || code === "workspace_name_ambiguous") return 409;
  if (code === "claim_token_invalid" || code === "claim_signature_invalid" || code === "session_signature_invalid" || code === "challenge_invalid" || code === "device_inactive") return 401;
  if (code === "challenge_rate_limited") return 429;
  if (code === "session_not_visible" || code === "pane_not_visible" || code === "tmux_unavailable") return 503;
  return 400;
}

function isMuximodHttpStatus(value: unknown): value is MuximodHttpStatus {
  return value === 400 || value === 401 || value === 403 || value === 404 || value === 409 || value === 410 || value === 426 || value === 429 || value === 500 || value === 503;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorResponse(error: unknown, origin: string): Response {
  const mapped = mapError(error);
  return corsResponse(errorBody(mapped), origin, mapped.status);
}

function errorBody(error: MuximodHttpError): { error: string; message: string; details?: Record<string, unknown> } {
  return { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
}

function notFound(origin: string): Response {
  return corsResponse({ error: "not_found", message: "Route not found" }, origin, 404);
}

function corsResponse(body: unknown, origin: string, status = 200): Response {
  return withCors(jsonResponse(body, status), origin);
}

function jsonResponse(body: unknown, status = 200): Response {
  const response = body === undefined
    ? new Response(null, { status })
    : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return response;
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization, x-muximod-pairing-token, x-muximod-hook-token");
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function* emptyEvents(): AsyncGenerator<never> {
  await new Promise<void>(() => undefined);
}
