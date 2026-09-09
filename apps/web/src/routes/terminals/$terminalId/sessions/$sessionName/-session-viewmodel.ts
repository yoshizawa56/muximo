import type { PaneSummary, TerminalEndpoint, TmuxSession } from "@muximo/contract/api";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import { muximodErrorMessage } from "../../../../../app/api/muximod-error.js";
import { fallbackSession, fallbackTerminal, useTerminalResources } from "../../../-terminal-resources";
import { hasCompletePaneLayout } from "./-pane-layout-policy";

const maxLayoutRefreshes = 3;
const layoutRefreshDelayMs = 50;

export type SessionOverviewViewModel = {
  terminal: TerminalEndpoint;
  session: TmuxSession;
  panes: PaneSummary[];
  status?: "loading" | "ready" | "error";
  errorMessage?: string | null;
  onSelectPane: (pane: PaneSummary) => void;
  onCreatePane: () => void;
  onRefresh: () => void;
  onBack: () => void;
  onDisconnect: () => void;
};

export function useSessionViewModel(): SessionOverviewViewModel {
  const navigate = useNavigate();
  const { terminalId, sessionName } = useParams({ from: "/terminals/$terminalId/sessions/$sessionName/" });
  const resources = useTerminalResources({ terminalId, sessionName });
  const scopedSessionName = resources.selectedSession?.name ?? sessionName;
  const panesQuery = useQuery(
    resources.utils.panes.list.queryOptions({
      input: scopedSessionName ? { session: scopedSessionName } : {},
      enabled: Boolean(resources.connection) && Boolean(sessionName),
      staleTime: 1_000,
      refetchInterval: 3_000,
      retry: 2,
      retryDelay: (attempt) => Math.min(250, layoutRefreshDelayMs * 2 ** attempt),
    }),
  );
  const panes = panesQuery.data?.panes ?? [];
  const completeLayout = hasCompletePaneLayout(panes);
  const layoutRefreshRef = useRef({ marker: -1, attempts: 0 });

  useEffect(() => {
    if (!panesQuery.isSuccess || panes.length === 0 || completeLayout) {
      layoutRefreshRef.current = { marker: panesQuery.dataUpdatedAt, attempts: 0 };
      return;
    }
    if (layoutRefreshRef.current.marker === panesQuery.dataUpdatedAt) return;
    if (layoutRefreshRef.current.attempts >= maxLayoutRefreshes) return;

    layoutRefreshRef.current = {
      marker: panesQuery.dataUpdatedAt,
      attempts: layoutRefreshRef.current.attempts + 1,
    };
    const timer = globalThis.setTimeout(() => {
      void panesQuery.refetch();
    }, layoutRefreshDelayMs);
    return () => globalThis.clearTimeout(timer);
  }, [completeLayout, panes.length, panesQuery.dataUpdatedAt, panesQuery.isSuccess, panesQuery.refetch]);

  const onRefresh = useCallback(() => {
    layoutRefreshRef.current = { marker: -1, attempts: 0 };
    void panesQuery.refetch();
  }, [panesQuery.refetch]);
  const layoutRefreshPending =
    panes.length > 0 &&
    !completeLayout &&
    !panesQuery.isError &&
    (panesQuery.isFetching || layoutRefreshRef.current.attempts < maxLayoutRefreshes);
  const layoutUnavailable = panes.length > 0 && !completeLayout && !layoutRefreshPending;

  return {
    terminal: resources.selectedTerminal ?? fallbackTerminal,
    session: resources.selectedSession ?? fallbackSession,
    panes,
    status:
      panesQuery.isPending || layoutRefreshPending
        ? "loading"
        : panesQuery.isError && panesQuery.data === undefined
          ? "error"
          : layoutUnavailable
            ? "error"
            : "ready",
    errorMessage:
      panesQuery.isError && panesQuery.data === undefined
        ? muximodErrorMessage(panesQuery.error, "Unable to load panes")
        : layoutUnavailable
          ? "Unable to read a complete tmux layout"
          : null,
    onSelectPane: (pane) => {
      void navigate({
        to: "/terminals/$terminalId/sessions/$sessionName/panes/$paneId",
        params: { terminalId, sessionName, paneId: pane.id },
      });
    },
    onCreatePane: () => {
      void navigate({
        to: "/terminals/$terminalId/sessions/$sessionName/panes/new",
        params: { terminalId, sessionName },
      });
    },
    onRefresh,
    onBack: () => {
      void navigate({ to: "/terminals/$terminalId/sessions", params: { terminalId } });
    },
    onDisconnect: () => {
      void navigate({
        to: "/terminals/$terminalId/sessions/$sessionName/disconnected",
        params: { terminalId, sessionName },
      });
    },
  };
}
