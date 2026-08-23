import { BunSocketAdapter } from "@muximo/infrastructure";
import type { WebSocketHandler } from "bun";
import { corsResponse } from "./middleware.js";
import type { MuximodHttpDependencies } from "./types.js";

export type MuximodWebSocketData = {
  endpoint: "terminal";
  context: import("@muximo/application").MuximodAuthContext;
  socket?: BunSocketAdapter;
};

export type UpgradeServer = {
  upgrade(request: Request, options: { data: MuximodWebSocketData }): boolean;
};

export function createWebSocketHandler(
  deps: MuximodHttpDependencies,
): WebSocketHandler<MuximodWebSocketData> & { idleTimeout: number } {
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

export async function handleTerminalUpgrade(
  request: Request,
  server: UpgradeServer | undefined,
  deps: MuximodHttpDependencies,
): Promise<Response | undefined> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return corsResponse({ error: "upgrade_required", message: "WebSocket upgrade is required" }, deps.corsOrigin, 426);
  }
  if (!server)
    return corsResponse(
      { error: "server_unavailable", message: "WebSocket server is unavailable" },
      deps.corsOrigin,
      503,
    );

  const ticket = new URL(request.url).searchParams.get("ticket") ?? undefined;
  const context = deps.auth.consumeWebSocketTicket(ticket, "terminal");
  if (!context)
    return corsResponse(
      { error: "unauthorized", message: "WebSocket authentication is required" },
      deps.corsOrigin,
      401,
    );

  if (server.upgrade(request, { data: { endpoint: "terminal", context } })) return undefined;
  return corsResponse({ error: "upgrade_failed", message: "WebSocket upgrade failed" }, deps.corsOrigin, 500);
}
