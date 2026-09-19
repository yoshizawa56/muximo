import type { PaneSummary as ProtocolPaneSummary } from "@muximo/contract/api";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MuximodConnection } from "../../../../../../../../app/api/muximod-client.js";
import { muximodErrorMessage } from "../../../../../../../../app/api/muximod-error.js";
import type { MuximodQueryUtils } from "../../../../../../../../app/api/orpc-utils";
import {
  hasCompletePaneLayout,
  paneLayoutMaxRefreshes,
  paneLayoutQueryRetryCount,
  paneLayoutQueryRetryDelay,
  paneLayoutQueryStatus,
  paneLayoutRefreshDelayMs,
} from "../../../-pane-layout-policy";
import { paneBoardQueryPolicy } from "./policy";

export type PaneSummary = ProtocolPaneSummary;

export function selectedTargetFromPaneId(
  panes: readonly PaneSummary[],
  selectedPaneId?: string,
  lastKnownTarget = "",
): string {
  return panes.find((pane) => pane.id === selectedPaneId)?.hostPaneId ?? lastKnownTarget;
}

const MAX_MISSING_INVENTORY_SNAPSHOTS = 2;

export type SelectedTargetMemory = {
  target: string;
  missingInventorySnapshots: number;
};

export type SelectedTargetMemoryInput = {
  panes: readonly PaneSummary[];
  selectedPaneId?: string;
  memory: SelectedTargetMemory;
  inventoryAuthoritative: boolean;
  inventorySnapshotMarker?: number;
  memorySnapshotMarker?: number;
};

export type SelectedTargetMemoryResult = SelectedTargetMemory;

/**
 * Retains a missing pane target only for transient inventory gaps. A
 * successful inventory that assigns the remembered target to another pane is
 * authoritative evidence that the tmux target was reused and must invalidate
 * the memory immediately.
 */
export function resolveSelectedTargetMemory(input: SelectedTargetMemoryInput): SelectedTargetMemoryResult {
  const selectedPane = input.panes.find((pane) => pane.id === input.selectedPaneId);
  if (selectedPane) return { target: selectedPane.hostPaneId, missingInventorySnapshots: 0 };

  if (!input.memory.target) return { target: "", missingInventorySnapshots: input.memory.missingInventorySnapshots };

  const targetReused =
    input.inventoryAuthoritative &&
    input.panes.some((pane) => pane.id !== input.selectedPaneId && pane.hostPaneId === input.memory.target);
  const snapshotChanged =
    input.inventorySnapshotMarker !== undefined && input.inventorySnapshotMarker !== input.memorySnapshotMarker;
  const missingInventorySnapshots =
    input.inventoryAuthoritative && snapshotChanged
      ? input.memory.missingInventorySnapshots + 1
      : input.memory.missingInventorySnapshots;
  if (targetReused || (input.inventoryAuthoritative && missingInventorySnapshots > MAX_MISSING_INVENTORY_SNAPSHOTS)) {
    return { target: "", missingInventorySnapshots };
  }
  return { target: input.memory.target, missingInventorySnapshots };
}

export type PaneBoardViewModel = {
  selectedTarget: string;
  panes: PaneSummary[];
  status: "loading" | "ready" | "error";
  errorMessage: string | null;
  select: (pane: PaneSummary) => void;
  refresh: () => void;
};

export type PaneBoardViewModelOptions = {
  onSelect: (paneId: string) => void;
  selectedPaneId?: string;
  sessionName?: string;
  connection?: MuximodConnection;
  utils: MuximodQueryUtils;
  pollWhenHidden?: boolean;
  pollIntervalMs?: number;
};

export function usePaneBoardViewModel({
  onSelect,
  selectedPaneId,
  sessionName,
  connection,
  utils,
  pollWhenHidden = false,
  pollIntervalMs,
}: PaneBoardViewModelOptions): PaneBoardViewModel {
  const queryPolicy = paneBoardQueryPolicy({
    hasConnection: Boolean(connection),
    hasSession: Boolean(sessionName),
    pollWhenHidden,
    pollIntervalMs,
  });
  const query = useQuery(
    utils.panes.list.queryOptions({
      input: sessionName ? { session: sessionName } : {},
      enabled: queryPolicy.enabled,
      staleTime: 1_000,
      refetchInterval: queryPolicy.refetchInterval,
      retry: paneLayoutQueryRetryCount,
      retryDelay: paneLayoutQueryRetryDelay,
    }),
  );

  const panes = query.data?.panes ?? [];
  const completeLayout = hasCompletePaneLayout(panes);
  const layoutRefreshRef = useRef({ marker: -1, attempts: 0 });

  useEffect(() => {
    if (!query.isSuccess || panes.length === 0 || completeLayout) {
      layoutRefreshRef.current = { marker: query.dataUpdatedAt, attempts: 0 };
      return;
    }
    if (layoutRefreshRef.current.marker === query.dataUpdatedAt) return;
    if (layoutRefreshRef.current.attempts >= paneLayoutMaxRefreshes) return;

    layoutRefreshRef.current = {
      marker: query.dataUpdatedAt,
      attempts: layoutRefreshRef.current.attempts + 1,
    };
    const timer = globalThis.setTimeout(() => {
      void query.refetch();
    }, paneLayoutRefreshDelayMs);
    return () => globalThis.clearTimeout(timer);
  }, [completeLayout, panes.length, query.dataUpdatedAt, query.isSuccess, query.refetch]);

  // Pane inventory is eventually consistent with the terminal transport. A
  // refresh can briefly omit the selected stable pane while tmux is resizing
  // or the connection is recovering, so keep its last host target within the
  // same route, session, and connection scope.
  const selectedTargetMemoryRef = useRef<{
    connection?: MuximodConnection;
    sessionName?: string;
    selectedPaneId?: string;
    target: string;
    missingInventorySnapshots: number;
    inventorySnapshotMarker?: number;
  }>({
    connection,
    sessionName,
    selectedPaneId,
    target: "",
    missingInventorySnapshots: 0,
  });
  const sameSelection =
    selectedTargetMemoryRef.current.connection === connection &&
    selectedTargetMemoryRef.current.sessionName === sessionName &&
    selectedTargetMemoryRef.current.selectedPaneId === selectedPaneId;
  const selectedTargetMemory = resolveSelectedTargetMemory({
    panes,
    selectedPaneId,
    memory: sameSelection ? selectedTargetMemoryRef.current : { target: "", missingInventorySnapshots: 0 },
    inventoryAuthoritative: query.isSuccess,
    inventorySnapshotMarker: query.dataUpdatedAt,
    memorySnapshotMarker: sameSelection ? selectedTargetMemoryRef.current.inventorySnapshotMarker : undefined,
  });
  const selectedTarget = selectedTargetMemory.target;
  useLayoutEffect(() => {
    selectedTargetMemoryRef.current = {
      connection,
      sessionName,
      selectedPaneId,
      target: selectedTargetMemory.target,
      missingInventorySnapshots: selectedTargetMemory.missingInventorySnapshots,
      inventorySnapshotMarker: query.dataUpdatedAt,
    };
  }, [
    connection,
    selectedPaneId,
    selectedTargetMemory.missingInventorySnapshots,
    selectedTargetMemory.target,
    sessionName,
    query.dataUpdatedAt,
  ]);
  const status = paneLayoutQueryStatus({
    paneCount: panes.length,
    completeLayout,
    queryPending: query.isPending,
    queryError: query.isError,
    queryFetching: query.isFetching,
    refreshAttempts: layoutRefreshRef.current.attempts,
  });
  const select = useCallback((pane: PaneSummary) => onSelect(pane.id), [onSelect]);
  const refresh = useCallback(() => {
    layoutRefreshRef.current = { marker: -1, attempts: 0 };
    void query.refetch();
  }, [query]);

  return {
    selectedTarget,
    panes,
    status,
    errorMessage: query.isError
      ? muximodErrorMessage(query.error, "Unable to load panes")
      : status === "error"
        ? "Unable to read a complete tmux layout"
        : null,
    select,
    refresh,
  };
}
