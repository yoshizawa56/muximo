import { useNavigate, useParams } from "@tanstack/react-router";
import type { TmuxSession } from "@muximo/contract";
import type { TerminalEndpoint } from "../../-connection-flow-viewmodel";
import { useTerminalResources } from "../../-terminal-resources";

export type SessionsViewModel = {
  terminals: TerminalEndpoint[];
  sessions: TmuxSession[];
  selectedTerminal: TerminalEndpoint | null;
  selectedSession: TmuxSession | null;
  status: "loading" | "ready" | "error" | undefined;
  errorMessage: string | null;
  onSelectSession: (session: TmuxSession) => void;
  onCreateSession: () => void;
  onBack: () => void;
};

export function useSessionsViewModel(): SessionsViewModel {
  const navigate = useNavigate();
  const { terminalId } = useParams({ from: "/terminals/$terminalId/sessions/" });
  const resources = useTerminalResources({ terminalId, pollSessions: true });

  return {
    terminals: resources.terminals,
    sessions: resources.sessions,
    selectedTerminal: resources.selectedTerminal,
    selectedSession: resources.selectedSession,
    status: resources.sessionsStatus,
    errorMessage: resources.sessionsError,
    onSelectSession: (session) => {
      void navigate({ to: "/terminals/$terminalId/sessions/$sessionName/connecting", params: { terminalId, sessionName: session.name } });
    },
    onCreateSession: () => {
      void navigate({ to: "/terminals/$terminalId/sessions/new", params: { terminalId } });
    },
    onBack: () => {
      void navigate({ to: "/terminals" });
    },
  };
}
