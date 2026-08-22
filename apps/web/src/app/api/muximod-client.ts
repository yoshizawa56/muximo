import { ORPCError, createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ContractRouterClient } from "@orpc/contract";
import { muximodContract, type MuximodEvent } from "@muximo/contract";

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

export class MuximodApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly details: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = "MuximodApiError";
  }
}

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
  const client = normalizeRpcErrors(createRawRpcClient(connection));
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
 * Wraps every callable in the client tree so rejections surface as
 * {@link MuximodApiError}. Router nodes stay plain proxies with stable
 * identity; leaf calls only normalize rejected promises.
 */
function normalizeRpcErrors<T>(value: T): T {
  const cache = new WeakMap<object, unknown>();
  const wrap = function wrapNode<V>(child: V): V {
    if (typeof child === "function") {
      const call = child as (...args: unknown[]) => unknown;
      return ((...args: unknown[]) =>
        Promise.resolve(call(...args)).catch((error: unknown) => {
          throw toMuximodApiError(error);
        })) as V;
    }
    if (!isRecord(child)) return child;
    const existing = cache.get(child);
    if (existing) return existing as V;
    const proxied = new Proxy(child, {
      get(target, property) {
        if (typeof property === "symbol") return Reflect.get(target, property);
        return wrap(Reflect.get(target, property));
      },
    });
    cache.set(child, proxied);
    return proxied as V;
  };
  return wrap(value);
}

function toMuximodApiError(error: unknown): unknown {
  if (!(error instanceof ORPCError)) return error;
  const data = isRecord(error.data) ? error.data : {};
  const details = isRecord(data.details) ? data.details : null;
  return new MuximodApiError(
    error.message,
    error.status,
    typeof data.code === "string" ? data.code : null,
    details,
  );
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
