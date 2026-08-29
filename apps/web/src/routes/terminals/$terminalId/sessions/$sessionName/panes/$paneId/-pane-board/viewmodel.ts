import type { PaneSummary as ProtocolPaneSummary } from "@muximo/contract/api";
import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import type { MuximodConnection } from "../../../../../../../../app/api/muximod-client.js";
import { muximodErrorMessage } from "../../../../../../../../app/api/muximod-error.js";
import type { MuximodQueryUtils } from "../../../../../../../../app/api/orpc-utils";
import { paneBoardQueryPolicy } from "./policy";

export type PaneSummary = ProtocolPaneSummary;

export function selectedTargetFromPaneId(panes: readonly PaneSummary[], selectedPaneId?: string): string {
  return panes.find((pane) => pane.id === selectedPaneId)?.hostPaneId ?? "";
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
  const selectedTarget = selectedTargetFromPaneId(panes, selectedPaneId);
  const select = useCallback((pane: PaneSummary) => onSelect(pane.id), [onSelect]);
  const refresh = useCallback(() => {
    void query.refetch();
  }, [query]);

  return {
    selectedTarget,
    panes,
    status: query.isPending ? "loading" : query.isError ? "error" : "ready",
    errorMessage: query.isError ? muximodErrorMessage(query.error, "Unable to load panes") : null,
    select,
    refresh,
  };
}
