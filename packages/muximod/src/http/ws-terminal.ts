import type { MuximodSocketAdapter } from "@muximo/infrastructure/runtime";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { corsResponse } from "./middleware.js";
import type { MuximodHttpDependencies } from "./types.js";

export const maxPendingWebProxyBytes = 1024 * 1024;

export type MuximodWebProxySocketData = {
  endpoint: "web-proxy";
  upstreamUrl: string;
  protocols: readonly string[];
  upstream?: WebSocket;
  pendingMessages: Array<string | ArrayBuffer | Uint8Array>;
  pendingMessageBytes: number;
};

export type MuximodWebSocketData =
  | {
      endpoint: "terminal";
      context: import("@muximo/application").MuximodAuthContext;
      socket?: MuximodSocketAdapter;
    }
  | MuximodWebProxySocketData;

export type UpgradeServer = {
  upgrade(request: Request, options: { data: MuximodWebSocketData; headers?: HeadersInit }): boolean;
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
        ws.data.pendingMessages.length = 0;
        ws.data.pendingMessageBytes = 0;
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
    // Forward the full offered list in client preference order so the
    // upstream server negotiates as it would with a direct client. The
    // downstream upgrade already committed to the first offer (see
    // handleWebProxyUpgrade); Vite HMR offers a single protocol in practice,
    // so both ends agree.
    upstream =
      data.protocols.length === 0
        ? new WebSocket(data.upstreamUrl)
        : new WebSocket(data.upstreamUrl, [...data.protocols]);
  } catch {
    ws.close(1011, "Web proxy upstream failed");
    return;
  }
  data.upstream = upstream;
  upstream.binaryType = "arraybuffer";
  upstream.onopen = () => {
    const pendingMessages = data.pendingMessages.splice(0);
    data.pendingMessageBytes = 0;
    for (const message of pendingMessages) upstream.send(toWebSocketMessage(message));
  };
  upstream.onmessage = (event) => {
    forwardUpstreamMessage(ws, event.data);
  };
  upstream.onclose = (event) => {
    if (ws.readyState !== 1) return;
    // Propagate the upstream outcome instead of masking it as an anonymous
    // close: Vite HMR clients reconnect on 1000/1012, while an explicit
    // upstream failure stays visible downstream.
    if (typeof event.code === "number" && event.code >= 1000 && event.code <= 4999) {
      ws.close(event.code, event.reason);
      return;
    }
    ws.close();
  };
  upstream.onerror = () => {
    if (ws.readyState === 1) ws.close(1011, "Web proxy upstream failed");
  };
}

function forwardWebProxyMessage(ws: MuximodServerWebSocket, message: string | Buffer): void {
  const data = ws.data;
  if (data.endpoint !== "web-proxy") return;
  if (ws.readyState !== 1) return;
  const messageBytes = webSocketMessageByteLength(message);
  if (data.upstream?.readyState === 1) {
    // Bound an established upstream the same way as the connecting queue:
    // without backpressure a flooding client grows runtime buffers without
    // limit even though the pending queue is capped.
    if (data.upstream.bufferedAmount + messageBytes > maxPendingWebProxyBytes) {
      data.pendingMessages.length = 0;
      data.pendingMessageBytes = 0;
      data.upstream.close(1009, "Web proxy buffer exceeded");
      ws.close(1009, "Web proxy buffer exceeded");
      return;
    }
    try {
      data.upstream.send(toWebSocketMessage(message));
    } catch {
      ws.close(1011, "Web proxy upstream failed");
    }
    return;
  }

  if (data.pendingMessageBytes + messageBytes > maxPendingWebProxyBytes) {
    data.pendingMessages.length = 0;
    data.pendingMessageBytes = 0;
    data.upstream?.close();
    ws.close(1009, "Web proxy buffer exceeded");
    return;
  }
  if (data.upstream === undefined || data.upstream.readyState === 0) {
    data.pendingMessages.push(message);
    data.pendingMessageBytes += messageBytes;
  }
}

function forwardUpstreamMessage(ws: MuximodServerWebSocket, message: string | ArrayBuffer | Blob | Uint8Array): void {
  if (ws.readyState !== 1) return;
  if (message instanceof Blob) {
    void message.arrayBuffer().then((value) => {
      if (ws.readyState !== 1) return;
      sendDownstream(ws, value);
    });
    return;
  }
  sendDownstream(ws, toWebSocketMessage(message));
}

/** Forwards one upstream frame, closing when downstream backpressure prevents delivery. */
function sendDownstream(ws: MuximodServerWebSocket, message: string | ArrayBuffer): void {
  try {
    // Bun reports 0 for a dropped frame and -1 when backpressure prevents
    // immediate delivery. The proxy cannot redraw like a terminal session,
    // so a lossy frame must close the connection instead of desynchronizing
    // the HMR stream.
    const status = ws.send(message);
    if (status === 0 || status === -1) ws.close(1013, "Web proxy downstream backpressure");
  } catch {
    ws.close(1011, "Web proxy downstream failed");
  }
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

function webSocketMessageByteLength(message: string | ArrayBuffer | Uint8Array): number {
  if (typeof message === "string") return Buffer.byteLength(message, "utf8");
  return message.byteLength;
}
