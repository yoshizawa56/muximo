import type { PaneSummary } from "@muximo/contract/api";

export const paneLayoutRefreshDelayMs = 50;
export const paneLayoutMaxRefreshes = 3;
export const paneLayoutQueryRetryCount = 2;

export function paneLayoutQueryRetryDelay(attempt: number): number {
  return Math.min(250, paneLayoutRefreshDelayMs * 2 ** attempt);
}

export type PaneLayoutQueryStatusInput = {
  paneCount: number;
  completeLayout: boolean;
  queryPending: boolean;
  queryError: boolean;
  queryFetching: boolean;
  refreshAttempts: number;
};

export function paneLayoutRefreshPending({
  paneCount,
  completeLayout,
  queryError,
  queryFetching,
  refreshAttempts,
}: Omit<PaneLayoutQueryStatusInput, "queryPending">): boolean {
  return paneCount > 0 && !completeLayout && !queryError && (queryFetching || refreshAttempts < paneLayoutMaxRefreshes);
}

export function paneLayoutQueryStatus(input: PaneLayoutQueryStatusInput): "loading" | "ready" | "error" {
  if (
    input.queryPending ||
    paneLayoutRefreshPending({
      paneCount: input.paneCount,
      completeLayout: input.completeLayout,
      queryError: input.queryError,
      queryFetching: input.queryFetching,
      refreshAttempts: input.refreshAttempts,
    })
  ) {
    return "loading";
  }
  if (input.queryError || (input.paneCount > 0 && !input.completeLayout)) return "error";
  return "ready";
}

export type PaneLayoutWindow = {
  id: string;
  windowId: string;
  sessionName: string;
  name: string;
  index: number;
  windowWidth?: number;
  windowHeight?: number;
  hasGeometry: boolean;
  panes: PaneSummary[];
};

export function buildPaneWindows(panes: readonly PaneSummary[]): PaneLayoutWindow[] {
  const windows = new Map<
    string,
    {
      id: string;
      windowId: string;
      sessionName: string;
      name: string;
      index: number;
      windowWidth?: number;
      windowHeight?: number;
      panes: PaneSummary[];
    }
  >();
  const uniquePanes = uniquePaneSummaries(panes);

  for (const pane of uniquePanes) {
    const id = paneWindowId(pane);
    const current = windows.get(id) ?? {
      id,
      windowId: pane.windowId,
      sessionName: pane.sessionName,
      name: pane.windowName ?? "",
      index: pane.windowIndex ?? tmuxWindowIndex(pane.windowId),
      panes: [],
    };
    current.panes.push(pane);
    windows.set(id, current);
  }
  return [...windows.values()]
    .map((window) => {
      const panes = [...window.panes].sort(comparePanes);
      const dimensions = sharedWindowDimensions(panes);
      const hasGeometry =
        dimensions !== undefined &&
        panes.every((pane) => hasPaneGeometryInWindow(pane, dimensions.width, dimensions.height)) &&
        !hasOverlappingPanes(panes);
      return {
        ...window,
        panes,
        windowWidth: dimensions?.width,
        windowHeight: dimensions?.height,
        hasGeometry,
      } satisfies PaneLayoutWindow;
    })
    .sort(compareWindows);
}

/**
 * Returns true only for a complete, self-consistent tmux layout snapshot.
 * Partial or mixed resize snapshots must be fetched again instead of being
 * rendered with synthesized geometry.
 */
export function hasCompletePaneLayout(panes: readonly PaneSummary[]): boolean {
  return buildPaneWindows(panes).every((window) => window.hasGeometry);
}

export function hasPaneGeometry(
  pane: Pick<PaneSummary, "left" | "top" | "width" | "height" | "windowWidth" | "windowHeight">,
): pane is Pick<PaneSummary, "left" | "top" | "width" | "height" | "windowWidth" | "windowHeight"> & {
  left: number;
  top: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
} {
  const { left, top, width, height, windowWidth, windowHeight } = pane;
  return (
    isNonNegativeInteger(left) &&
    isNonNegativeInteger(top) &&
    isPositiveInteger(width) &&
    isPositiveInteger(height) &&
    isPositiveInteger(windowWidth) &&
    isPositiveInteger(windowHeight) &&
    left + width <= windowWidth &&
    top + height <= windowHeight
  );
}

export function paneWindowId(pane: Pick<PaneSummary, "sessionName" | "windowId">): string {
  return JSON.stringify([pane.sessionName, pane.windowId]);
}

function uniquePaneSummaries(panes: readonly PaneSummary[]): PaneSummary[] {
  const unique = new Map<string, PaneSummary>();
  for (const pane of panes) {
    const identity = `${pane.sessionName}\u0000${pane.windowId}\u0000${pane.id || pane.hostPaneId}`;
    if (!unique.has(identity)) unique.set(identity, pane);
  }
  return [...unique.values()];
}

function tmuxWindowIndex(windowId: string): number {
  const value = Number(windowId.replace(/^@/, ""));
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function comparePanes(left: PaneSummary, right: PaneSummary): number {
  return (
    compareOptionalNumbers(left.paneIndex, right.paneIndex) ||
    compareOptionalNumbers(left.top, right.top) ||
    compareOptionalNumbers(left.left, right.left) ||
    left.hostPaneId.localeCompare(right.hostPaneId)
  );
}

function compareWindows(left: PaneLayoutWindow, right: PaneLayoutWindow): number {
  return (
    left.sessionName.localeCompare(right.sessionName) ||
    left.index - right.index ||
    left.windowId.localeCompare(right.windowId)
  );
}

function compareOptionalNumbers(left: number | undefined, right: number | undefined): number {
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return left - right;
}

function sharedWindowDimensions(panes: readonly PaneSummary[]): { width: number; height: number } | undefined {
  const first = panes[0];
  if (!first || !isPositiveInteger(first.windowWidth) || !isPositiveInteger(first.windowHeight)) return undefined;
  if (panes.some((pane) => pane.windowWidth !== first.windowWidth || pane.windowHeight !== first.windowHeight)) {
    return undefined;
  }
  return { width: first.windowWidth, height: first.windowHeight };
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}

function hasPaneGeometryInWindow(pane: PaneSummary, windowWidth: number, windowHeight: number): boolean {
  return (
    hasPaneGeometry(pane) &&
    pane.windowWidth === windowWidth &&
    pane.windowHeight === windowHeight &&
    pane.left + pane.width <= windowWidth &&
    pane.top + pane.height <= windowHeight
  );
}

function hasOverlappingPanes(panes: readonly PaneSummary[]): boolean {
  for (let index = 0; index < panes.length; index += 1) {
    const left = panes[index];
    if (!left || !hasPaneGeometry(left)) continue;
    for (let otherIndex = index + 1; otherIndex < panes.length; otherIndex += 1) {
      const right = panes[otherIndex];
      if (!right || !hasPaneGeometry(right)) continue;
      const overlapsHorizontally = left.left < right.left + right.width && right.left < left.left + left.width;
      const overlapsVertically = left.top < right.top + right.height && right.top < left.top + left.height;
      if (overlapsHorizontally && overlapsVertically) return true;
    }
  }
  return false;
}

function isNonNegativeInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 0;
}
