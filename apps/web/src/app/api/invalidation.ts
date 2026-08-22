import type { QueryClient } from "@tanstack/react-query";
import { muximodContract, type MuximodEvent } from "@muximo/contract";
import type { MuximodQueryUtils } from "./orpc-utils.js";

/**
 * The single place that decides which cache regions a cause invalidates.
 *
 * Completeness is enforced by types in both directions:
 * - every resource group declared by the contract must appear in
 *   `resourceGroups` (the exhaustive assertion below fails to compile when a
 *   new group is added to the contract but not here);
 * - invalidation always goes through subtree-level partial keys, so clearing
 *   a group covers every list/get/input variant under it.
 */

type ContractRoot = typeof muximodContract;
export type ResourceGroup = Exclude<keyof ContractRoot, "auth" | "events" | "health" | "capabilities">;

const resourceGroups = ["workspaces", "terminals", "sessions", "panes"] as const satisfies readonly ResourceGroup[];

type UnhandledResourceGroup = Exclude<ResourceGroup, (typeof resourceGroups)[number]>;
const _everyResourceGroupIsHandled: UnhandledResourceGroup extends never ? true : ["unhandled resource groups:", UnhandledResourceGroup] = true;

interface GroupNode {
  key(options?: { type?: "query"; input?: Record<string, unknown> }): unknown;
}

function invalidateGroups(queryClient: QueryClient, utils: MuximodQueryUtils, groups: readonly ResourceGroup[]): void {
  for (const group of groups) {
    const node: GroupNode = utils[group];
    void queryClient.invalidateQueries({ queryKey: node.key({ type: "query" }) });
  }
}

/**
 * Any session activity event invalidates everything derived from sessions.
 * Events carry no resource data, so finer targeting would be guesswork;
 * workspaces and terminals are only changed by their own mutations and are
 * therefore cleared there instead.
 */
export function invalidateOnMuximodEvent(queryClient: QueryClient, utils: MuximodQueryUtils, _event: MuximodEvent): void {
  invalidateSessionData(queryClient, utils);
}

/** Sessions changed (created, removed, or pane activity inside them). */
export function invalidateSessionData(queryClient: QueryClient, utils: MuximodQueryUtils): void {
  invalidateGroups(queryClient, utils, ["sessions", "panes"]);
}

/** Workspaces changed (registered, updated, or unregistered). */
export function invalidateWorkspaceData(queryClient: QueryClient, utils: MuximodQueryUtils): void {
  invalidateGroups(queryClient, utils, ["workspaces"]);
}

/** Terminal inventory changed. */
export function invalidateTerminalData(queryClient: QueryClient, utils: MuximodQueryUtils): void {
  invalidateGroups(queryClient, utils, ["terminals"]);
}

/**
 * A fresh connection (first connect or reconnect) may have missed any change,
 * so clear every cached region including the rarely-changing health and
 * capability snapshots.
 */
export function invalidateOnReconnect(queryClient: QueryClient, utils: MuximodQueryUtils): void {
  invalidateAllResources(queryClient, utils);
  void queryClient.invalidateQueries({ queryKey: utils.health.key({ type: "query" }) });
  void queryClient.invalidateQueries({ queryKey: utils.capabilities.key({ type: "query" }) });
}

/** Invalidates one whole resource group. Mutation handlers call this. */
export function invalidateResourceGroup(queryClient: QueryClient, utils: MuximodQueryUtils, group: ResourceGroup): void {
  invalidateGroups(queryClient, utils, [group]);
}

export function invalidateAllResources(queryClient: QueryClient, utils: MuximodQueryUtils): void {
  invalidateGroups(queryClient, utils, resourceGroups);
}
