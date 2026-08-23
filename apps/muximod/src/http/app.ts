import { muximodHealthSchema } from "@muximo/contract";
import { RPCHandler } from "@orpc/server/fetch";
import type { WebSocketHandler } from "bun";
import {
  corsResponse,
  errorBody,
  errorResponse,
  jsonResponse,
  MuximodHttpError,
  notFound,
  withCors,
} from "./middleware.js";
import { contextForRequest, createMuximodRouter, type MuximodRpcContext } from "./rpc-handlers.js";
import { handleTmuxHook } from "./tmux-hook.js";
import type { MuximodHttpDependencies } from "./types.js";
import {
  createWebSocketHandler,
  handleTerminalUpgrade,
  type MuximodWebSocketData,
  type UpgradeServer,
} from "./ws-terminal.js";

export type { MuximodSocket, MuximodSocketData } from "@muximo/application";
export { BunSocketAdapter, muximodSocketReadyState } from "@muximo/infrastructure";
export { MuximodHttpError } from "./middleware.js";
export type { MuximodRpcContext } from "./rpc-handlers.js";
export type {
  MuximodAuthContext,
  MuximodAuthPort,
  MuximodHookEvent,
  MuximodHttpDependencies,
  MuximodHttpStatus,
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
      return jsonResponse(
        errorBody(new MuximodHttpError(503, "muximod_unavailable", "muximod is still starting")),
        503,
      );
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
