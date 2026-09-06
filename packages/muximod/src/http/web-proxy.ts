import type { MuximodWebSettings } from "@muximo/contract/control";
import type { MuximodHttpLogger } from "./types.js";
import type { MuximodWebProxySocketData, UpgradeServer } from "./ws-terminal.js";

type WebProxySettings = MuximodWebSettings["proxy"];

/** Caps proxied request bodies: the Vite surface only needs small HMR and asset posts. */
export const maxWebProxyRequestBodyBytes = 1024 * 1024;
const webProxyRequestTimeoutMs = 30_000;

/** Proxies the unauthenticated Web development surface to the loopback Vite server. */
export async function proxyWebRequest(
  request: Request,
  settings: WebProxySettings,
  logger?: MuximodHttpLogger,
): Promise<Response> {
  const target = createWebProxyTarget(request, settings, "http:");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), webProxyRequestTimeoutMs);
  try {
    const response = await fetch(target, { ...(await createRequestInit(request)), signal: controller.signal });
    return response;
  } catch (error) {
    if (error instanceof WebProxyRequestTooLargeError) {
      return new Response("Web proxy request body is too large", {
        status: 413,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    if (controller.signal.aborted) {
      logger?.debug("web.proxy_request_timeout", { method: request.method });
      return new Response("Web development server timed out", {
        status: 504,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    logger?.debug("web.proxy_request_failed", { message: error instanceof Error ? error.message : String(error) });
    return new Response("Web development server is unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  } finally {
    clearTimeout(timeout);
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

  const protocols = readWebSocketProtocols(request);
  if (protocols === undefined) return new Response("Invalid WebSocket subprotocol", { status: 400 });

  const data: MuximodWebProxySocketData = {
    endpoint: "web-proxy",
    upstreamUrl: createWebProxyTarget(request, settings, "ws:").toString(),
    protocols,
    pendingMessages: [],
    pendingMessageBytes: 0,
  };
  const upgradeOptions =
    protocols.length === 0 ? { data } : { data, headers: { "Sec-WebSocket-Protocol": protocols[0] } };
  if (server.upgrade(request, upgradeOptions)) return undefined;
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
  if (request.method !== "GET" && request.method !== "HEAD") {
    const body = await readCappedRequestBody(request, maxWebProxyRequestBodyBytes);
    if (body === undefined) {
      throw new WebProxyRequestTooLargeError();
    }
    init.body = body;
  }
  return init;
}

class WebProxyRequestTooLargeError extends Error {
  public constructor() {
    super("Web proxy request body exceeds the limit");
    this.name = "WebProxyRequestTooLargeError";
  }
}

/** Reads the request body up to the given cap without trusting Content-Length. */
export async function readCappedRequestBody(request: Request, maxBytes: number): Promise<ArrayBuffer | undefined> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsed = Number.parseInt(declaredLength, 10);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > maxBytes) return undefined;
  }
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) return undefined;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer as ArrayBuffer;
}

function readWebSocketProtocols(request: Request): string[] | undefined {
  const header = request.headers.get("sec-websocket-protocol");
  if (header === null) return [];

  const protocols = header.split(",").map((protocol) => protocol.trim());
  if (
    protocols.length === 0 ||
    protocols.some((protocol) => !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(protocol)) ||
    new Set(protocols).size !== protocols.length
  ) {
    return undefined;
  }
  return protocols;
}
