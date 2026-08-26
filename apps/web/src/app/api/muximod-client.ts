import type { MuximodEvent, muximodContract } from "@muximo/contract";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { MuximodApiError, isMuximodApiError } from "./muximod-error.js";

export { MuximodApiError } from "./muximod-error.js";

export type MuximodRouteKind = "serve" | "same-origin" | "lan" | "ssh";

export type MuximodConnection = {
  httpBaseUrl: string;
  websocketUrl: string;
  route?: MuximodRouteKind;
  auth?: MuximodAuthProvider;
  close?: () => Promise<void>;
};

export type MuximodAuthProvider = {
  getAccessToken: () => Promise<string>;
  invalidateAccessToken?: () => void;
  getWebSocketTicket: (endpoint: "terminal") => Promise<string>;
};

export type MuximodRouteProvider = {
  kind: MuximodRouteKind;
  open: () => Promise<MuximodConnection>;
};

type MuximodClientContext = {
  pairingToken?: string;
};

export type MuximodRpcClient = ContractRouterClient<typeof muximodContract, MuximodClientContext>;

/**
 * Stable cache/namespace identity for a connection. Query utils and
 * invalidation scope every key under this segment so two connections can
 * never share or clear each other's cache entries.
 */
export function muximodConnectionKey(connection: MuximodConnection | undefined): string {
  return connection ? `${connection.route ?? "custom"}:${connection.httpBaseUrl}` : "unconfigured";
}

export function createServeConnection(serveUrl: string): MuximodConnection {
  return createUrlConnection(serveUrl, "serve");
}

export function createSameOriginConnection(origin: string): MuximodConnection {
  return createUrlConnection(origin, "same-origin");
}

/**
 * Sentinel connection used when no profile is configured yet. Query utilities
 * built on it stay disabled (`enabled: false`) but exist so hooks never have
 * to assert non-nullness.
 */
export const unconfiguredMuximodConnection: MuximodConnection = Object.freeze({
  httpBaseUrl: "",
  websocketUrl: "",
});

const rpcCache = new WeakMap<MuximodConnection, MuximodRpcClient>();

/**
 * Returns the contract-typed RPC client for a connection. Errors thrown by
 * oRPC are normalized to {@link MuximodApiError} at this single boundary.
 * The client is memoized per connection object so headers and links are
 * built once instead of on every call.
 */
export function muximodRpc(connection: MuximodConnection): MuximodRpcClient {
  const cached = rpcCache.get(connection);
  if (cached) return cached;
  const client = normalizeRpcErrors(createRawRpcClient(connection), connection);
  rpcCache.set(connection, client);
  return client;
}

function createRawRpcClient(connection: MuximodConnection): MuximodRpcClient {
  const link = new RPCLink<MuximodClientContext>({
    url: `${ensureTrailingSlash(connection.httpBaseUrl)}rpc`,
    headers: async ({ context }) => {
      const headers: Record<string, string> = {};
      if (connection.auth) headers.authorization = `Bearer ${await connection.auth.getAccessToken()}`;
      if (context.pairingToken) headers["x-muximod-pairing-token"] = context.pairingToken;
      return headers;
    },
  });
  return createORPCClient<MuximodRpcClient>(link);
}

/**
 * Wraps every node in the client tree so rejections surface as
 * {@link MuximodApiError}. oRPC client nodes are simultaneously callables and
 * namespaces, so both the `apply` and `get` traps must be intercepted while
 * preserving stable identity per underlying node.
 */
/**
 * Property reads on oRPC client nodes extend their RPC path, so these
 * well-known function methods must never be forwarded into the underlying
 * chain; native implementations are served from Function.prototype instead.
 */
const rpcNodeMethodKeys = new Set(["then", "bind", "call", "apply", "toString", "valueOf", "toJSON"]);

function normalizeRpcErrors<T>(value: T, connection: MuximodConnection): T {
  const cache = new WeakMap<object, unknown>();
  const wrap = function wrapNode<V>(child: V): V {
    if (typeof child !== "function" && !isRecord(child)) return child;
    const existing = cache.get(child);
    if (existing) return existing as V;
    const target: object = child;
    const proxied = new Proxy(target, {
      apply(applyTarget: (...args: unknown[]) => unknown, thisArg: unknown, argumentsList: unknown[]): unknown {
        try {
          // Reflect.apply invokes [[Call]] without reading properties; method
          // access (.apply/.bind/...) would extend the oRPC procedure path.
          const result = Reflect.apply(applyTarget, thisArg, argumentsList);
          return result instanceof Promise
            ? result.catch((error: unknown) => {
                throw normalizeRpcError(error, connection);
              })
            : result;
        } catch (error: unknown) {
          throw normalizeRpcError(error, connection);
        }
      },
      get(getTarget: object, property: string | symbol): unknown {
        if (typeof property === "symbol") return Reflect.get(getTarget, property);
        if (rpcNodeMethodKeys.has(property) && typeof child === "function") {
          return (Function.prototype as unknown as Record<string, unknown>)[property];
        }
        return wrap(Reflect.get(getTarget, property));
      },
    }) as V;
    cache.set(child, proxied);
    return proxied;
  };
  return wrap(value);
}

function normalizeRpcError(error: unknown, connection: MuximodConnection): unknown {
  const normalized = toMuximodApiError(error);
  if (isMuximodApiError(normalized) && normalized.status === 401)
    connection.auth?.invalidateAccessToken?.();
  return normalized;
}

function toMuximodApiError(error: unknown): unknown {
  if (!(error instanceof ORPCError)) return error;
  const data = isRecord(error.data) ? error.data : {};
  const details = isRecord(data.details) ? data.details : null;
  return new MuximodApiError(error.message, error.status, typeof data.code === "string" ? data.code : null, details);
}

export async function openMuximodTerminal(connection: MuximodConnection): Promise<WebSocket> {
  if (!connection.auth) return new WebSocket(connection.websocketUrl);
  const url = new URL(connection.websocketUrl);
  url.searchParams.set("ticket", await connection.auth.getWebSocketTicket("terminal"));
  return new WebSocket(url.toString());
}

/**
 * Subscribes to the server event stream. Events carry no resource data:
 * consumers use them as invalidation hints through the invalidation matrix.
 */
export function openMuximodEvents(connection: MuximodConnection): Promise<AsyncIteratorObject<MuximodEvent>> {
  return muximodRpc(connection).events.subscribe({});
}

function ensureTrailingSlash(value: string): string {
  if (!value) return "/";
  return value.endsWith("/") ? value : `${value}/`;
}

function createUrlConnection(baseUrl: string, route: MuximodRouteKind): MuximodConnection {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`muximod URL must use http or https: ${baseUrl}`);
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  const httpBaseUrl = `${url.origin}${normalizedPath}`;
  const websocketProtocol = url.protocol === "https:" ? "wss:" : "ws:";
  const websocketUrl = `${websocketProtocol}//${url.host}${normalizedPath}/terminal`;
  return { httpBaseUrl, websocketUrl, route };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
