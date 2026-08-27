import type { MuximodSocketAdapter } from "@muximo/infrastructure";
import type { WebSocketHandler } from "bun";
import { corsResponse } from "./middleware.js";
import type { MuximodHttpDependencies } from "./types.js";

export type MuximodWebSocketData = {
  endpoint: "terminal";
  context: import("@muximo/application").MuximodAuthContext;
  socket?: MuximodSocketAdapter;
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
      const socket = deps.socketFactory(ws);
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
    return corsResponse(
      { error: "upgrade_required", message: "WebSocket upgrade is required" },
      request,
      deps.originPolicy,
      426,
    );
  }
  if (!server)
    return corsResponse(
      { error: "server_unavailable", message: "WebSocket server is unavailable" },
      request,
      deps.originPolicy,
      503,
    );

  const ticket = new URL(request.url).searchParams.get("ticket") ?? undefined;
  const context = await deps.auth.consumeWebSocketTicket(ticket, "terminal");
  if (!context)
    return corsResponse(
      { error: "unauthorized", message: "WebSocket authentication is required" },
      request,
      deps.originPolicy,
      401,
    );

  if (server.upgrade(request, { data: { endpoint: "terminal", context } })) return undefined;
  return corsResponse(
    { error: "upgrade_failed", message: "WebSocket upgrade failed" },
    request,
    deps.originPolicy,
    500,
  );
}
