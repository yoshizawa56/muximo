import { RPCHandler } from "@orpc/server/fetch";
import type { WebSocketHandler } from "bun";
import { presentMuximodHealth } from "./health.js";
import { corsResponse, errorResponse, jsonResponse, notFound, originDeniedResponse, withCors } from "./middleware.js";
import { contextForRequest, createMuximodRouter, type MuximodRpcContext } from "./rpc-handlers.js";
import { handleTmuxHook } from "./tmux-hook.js";
import type { MuximodHttpDependencies } from "./types.js";
import {
  createWebSocketHandler,
  handleTerminalUpgrade,
  type MuximodWebSocketData,
  type UpgradeServer,
} from "./ws-terminal.js";

export type { MuximodSocket, MuximodSocketData } from "@muximo/infrastructure/runtime";
export { muximodSocketReadyState } from "@muximo/infrastructure/runtime";
export { MuximodHttpError } from "./middleware.js";
export type { MuximodRpcContext } from "./rpc-handlers.js";
export type {
  MuximodAuthContext,
  MuximodAuthPort,
  MuximodHookEvent,
  MuximodHttpDependencies,
  MuximodHttpStatus,
  MuximodOriginPolicy,
} from "./types.js";
export type { MuximodWebSocketData } from "./ws-terminal.js";

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
        response = errorResponse(error, request, deps.originPolicy);
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

async function handleRequest(
  request: Request,
  server: UpgradeServer | undefined,
  deps: MuximodHttpDependencies,
  handler: RPCHandler<MuximodRpcContext>,
): Promise<Response | undefined> {
  const url = new URL(request.url);

  if (url.pathname === "/terminal") {
    if (!deps.originPolicy.allows(request.headers.get("origin"))) return originDeniedResponse();
    return handleTerminalUpgrade(request, server, deps);
  }

  if (url.pathname === "/health") {
    if (request.method === "OPTIONS") return corsResponse(undefined, request, deps.originPolicy, 204);
    const health = presentMuximodHealth(deps.isReady?.() ?? true);
    return jsonResponse(health.body, health.status);
  }

  if (url.pathname === "/internal/tmux-hook") {
    return handleTmuxHook(request, deps);
  }

  if (url.pathname === "/rpc" || url.pathname.startsWith("/rpc/")) {
    if (!deps.originPolicy.allows(request.headers.get("origin"))) return originDeniedResponse();
    if (request.method === "OPTIONS") return corsResponse(undefined, request, deps.originPolicy, 204);
    const result = await handler.handle(request, {
      prefix: "/rpc",
      context: await contextForRequest(request, deps),
    });
    return result.matched
      ? withCors(result.response, request, deps.originPolicy)
      : notFound(request, deps.originPolicy);
  }

  return notFound(request, deps.originPolicy);
}
