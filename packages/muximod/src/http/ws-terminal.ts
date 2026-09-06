import type { MuximodSocketAdapter } from "@muximo/infrastructure/runtime";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { corsResponse } from "./middleware.js";
import type { MuximodHttpDependencies } from "./types.js";

export type MuximodWebProxySocketData = {
  endpoint: "web-proxy";
  upstreamUrl: string;
  upstream?: WebSocket;
  pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
};

export type MuximodWebSocketData =
  | {
      endpoint: "terminal";
      context: import("@muximo/application").MuximodAuthContext;
      socket?: MuximodSocketAdapter;
    }
  | MuximodWebProxySocketData;

export type UpgradeServer = {
  upgrade(request: Request, options: { data: MuximodWebSocketData }): boolean;
};

type MuximodServerWebSocket = ServerWebSocket<MuximodWebSocketData>;

export function createWebSocketHandler(
  deps: MuximodHttpDependencies,
): WebSocketHandler<MuximodWebSocketData> & { idleTimeout: number } {
  return {
    data: {} as MuximodWebSocketData,
    idleTimeout: 0,
    open: (ws) => {
      if (ws.data.endpoint === "web-proxy") {
        openWebProxySocket(ws);
        return;
      }
      const socket = deps.socketFactory(ws);
      ws.data.socket = socket;
      deps.onTerminalConnection?.(socket, ws.data.context);
    },
    message: (ws, message) => {
      if (ws.data.endpoint === "web-proxy") {
        forwardWebProxyMessage(ws, message);
        return;
      }
      ws.data.socket?.receive(message);
    },
    close: (ws) => {
      if (ws.data.endpoint === "web-proxy") {
        ws.data.upstream?.close();
        return;
      }
      ws.data.socket?.receiveClose();
    },
  };
}

function openWebProxySocket(ws: MuximodServerWebSocket): void {
  const data = ws.data;
  if (data.endpoint !== "web-proxy") return;
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(data.upstreamUrl);
  } catch {
    ws.close(1011, "Web proxy upstream failed");
    return;
  }
  data.upstream = upstream;
  upstream.binaryType = "arraybuffer";
  upstream.onopen = () => {
    for (const message of data.pendingMessages) upstream.send(toWebSocketMessage(message));
    data.pendingMessages.length = 0;
  };
  upstream.onmessage = (event) => {
    forwardUpstreamMessage(ws, event.data);
  };
  upstream.onclose = () => {
    if (ws.readyState === 1) ws.close();
  };
  upstream.onerror = () => {
    if (ws.readyState === 1) ws.close(1011, "Web proxy upstream failed");
  };
}

function forwardWebProxyMessage(ws: MuximodServerWebSocket, message: string | Buffer): void {
  const data = ws.data;
  if (data.endpoint !== "web-proxy") return;
  if (data.upstream?.readyState === 1) {
    data.upstream.send(toWebSocketMessage(message));
    return;
  }
  if (data.upstream === undefined || data.upstream.readyState === 0) data.pendingMessages.push(message);
}

function forwardUpstreamMessage(ws: MuximodServerWebSocket, message: string | ArrayBuffer | Blob | Uint8Array): void {
  if (ws.readyState !== 1) return;
  if (message instanceof Blob) {
    void message.arrayBuffer().then((value) => {
      if (ws.readyState === 1) ws.send(value);
    });
    return;
  }
  ws.send(toWebSocketMessage(message));
}

function toWebSocketMessage(message: string | ArrayBuffer | Uint8Array): string | ArrayBuffer {
  if (typeof message === "string" || message instanceof ArrayBuffer) return message;
  return message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
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
