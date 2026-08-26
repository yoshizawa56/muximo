import type { PaneSummary, TerminalEndpoint, TmuxSession } from "@muximo/contract";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { muximodErrorMessage } from "../../../../../app/api/muximod-error.js";
import { fallbackSession, fallbackTerminal, useTerminalResources } from "../../../-terminal-resources";

export type SessionOverviewViewModel = {
  terminal: TerminalEndpoint;
  session: TmuxSession;
  panes: PaneSummary[];
  status?: "loading" | "ready" | "error";
  errorMessage?: string | null;
  onSelectPane: (pane: PaneSummary) => void;
  onCreatePane: () => void;
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
    }),
  );
  const panes = panesQuery.data?.panes ?? [];

  return {
    terminal: resources.selectedTerminal ?? fallbackTerminal,
    session: resources.selectedSession ?? fallbackSession,
    panes,
    status: panesQuery.isPending ? "loading" : panesQuery.isError ? "error" : "ready",
    errorMessage: panesQuery.isError ? muximodErrorMessage(panesQuery.error, "Unable to load panes") : null,
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
