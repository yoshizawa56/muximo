import type { PaneSummary as ProtocolPaneSummary } from "@muximo/contract/api";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef } from "react";
import type { MuximodConnection } from "../../../../../../../../app/api/muximod-client.js";
import { muximodErrorMessage } from "../../../../../../../../app/api/muximod-error.js";
import type { MuximodQueryUtils } from "../../../../../../../../app/api/orpc-utils";
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
  inventorySnapshotChanged: boolean;
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
  const missingInventorySnapshots =
    input.inventoryAuthoritative && input.inventorySnapshotChanged
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
    }),
  );

  const panes = query.data?.panes ?? [];
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
    inventorySnapshot?: readonly PaneSummary[];
  }>({
    connection,
    sessionName,
    selectedPaneId,
    target: "",
    missingInventorySnapshots: 0,
    inventorySnapshot: undefined,
  });
  const sameSelection =
    selectedTargetMemoryRef.current.connection === connection &&
    selectedTargetMemoryRef.current.sessionName === sessionName &&
    selectedTargetMemoryRef.current.selectedPaneId === selectedPaneId;
  const selectedTargetMemory = resolveSelectedTargetMemory({
    panes,
    selectedPaneId,
    memory: sameSelection ? selectedTargetMemoryRef.current : { target: "", missingInventorySnapshots: 0 },
    inventoryAuthoritative: query.data !== undefined && !query.isError,
    inventorySnapshotChanged: query.data?.panes !== selectedTargetMemoryRef.current.inventorySnapshot,
  });
  const selectedTarget = selectedTargetMemory.target;
  useLayoutEffect(() => {
    selectedTargetMemoryRef.current = {
      connection,
      sessionName,
      selectedPaneId,
      target: selectedTargetMemory.target,
      missingInventorySnapshots: selectedTargetMemory.missingInventorySnapshots,
      inventorySnapshot: query.data?.panes,
    };
  }, [
    connection,
    selectedPaneId,
    selectedTargetMemory.missingInventorySnapshots,
    selectedTargetMemory.target,
    query.data?.panes,
    sessionName,
  ]);
  const select = useCallback((pane: PaneSummary) => onSelect(pane.id), [onSelect]);
  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    selectedTarget,
    panes,
    status: query.isPending ? "loading" : query.isError && query.data === undefined ? "error" : "ready",
    errorMessage:
      query.isError && query.data === undefined ? muximodErrorMessage(query.error, "Unable to load panes") : null,
    select,
    refresh,
  };
}
