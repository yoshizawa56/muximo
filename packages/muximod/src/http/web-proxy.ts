import type { MuximodWebSettings } from "@muximo/contract/control";
import type { MuximodHttpLogger } from "./types.js";
import type { MuximodWebProxySocketData, UpgradeServer } from "./ws-terminal.js";

type WebProxySettings = MuximodWebSettings["proxy"];

/** Proxies the unauthenticated Web development surface to the loopback Vite server. */
export async function proxyWebRequest(
  request: Request,
  settings: WebProxySettings,
  logger?: MuximodHttpLogger,
): Promise<Response> {
  const target = createWebProxyTarget(request, settings, "http:");
  try {
    const response = await fetch(target, await createRequestInit(request));
    return response;
  } catch (error) {
    logger?.debug("web.proxy_request_failed", { message: error instanceof Error ? error.message : String(error) });
    return new Response("Web development server is unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
}

export function handleWebProxyUpgrade(
  request: Request,
  server: UpgradeServer | undefined,
  settings: WebProxySettings,
): Response | undefined {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return new Response("WebSocket upgrade is required", { status: 426 });
  }
  if (!server) return new Response("WebSocket server is unavailable", { status: 503 });

  const data: MuximodWebProxySocketData = {
    endpoint: "web-proxy",
    upstreamUrl: createWebProxyTarget(request, settings, "ws:").toString(),
    pendingMessages: [],
  };
  if (server.upgrade(request, { data })) return undefined;
  return new Response("WebSocket upgrade failed", { status: 500 });
}

export function createWebProxyTarget(
  request: Request,
  settings: Pick<WebProxySettings, "host" | "port">,
  protocol: "http:" | "ws:",
): URL {
  const target = new URL(request.url);
  target.protocol = protocol;
  target.hostname = settings.host;
  target.port = String(settings.port);
  target.username = "";
  target.password = "";
  return target;
}

async function createRequestInit(request: Request): Promise<RequestInit> {
  const headers = new Headers(request.headers);
  for (const header of [
    "authorization",
    "connection",
    "cookie",
    "host",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
  ]) {
    headers.delete(header);
  }
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") init.body = await request.arrayBuffer();
  return init;
}
