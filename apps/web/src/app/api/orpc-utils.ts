import { createTanstackQueryUtils, type RouterUtils } from "@orpc/tanstack-query";
import { type MuximodConnection, type MuximodRpcClient, muximodConnectionKey, muximodRpc } from "./muximod-client.js";

/**
 * Contract-shaped TanStack Query utilities. Query keys are derived from the
 * oRPC contract path plus input; they are never written by hand elsewhere.
 * Every key is prefixed with the connection identity so separate connections
 * cannot share or invalidate each other's cache entries.
 */
export type MuximodQueryUtils = RouterUtils<MuximodRpcClient>;

const utilsCache = new WeakMap<MuximodConnection, MuximodQueryUtils>();

export function muximodQueryUtils(connection: MuximodConnection): MuximodQueryUtils {
  const cached = utilsCache.get(connection);
  if (cached) return cached;
  const utils = createTanstackQueryUtils(muximodRpc(connection), {
    path: ["muximod", muximodConnectionKey(connection)],
  });
  utilsCache.set(connection, utils);
  return utils;
}
