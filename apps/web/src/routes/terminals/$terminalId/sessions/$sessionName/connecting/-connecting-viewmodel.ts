import { useEffect } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { TmuxSession } from "@muximo/contract";
import type { TerminalEndpoint } from "../../../../-connection-flow-viewmodel";
import { useTerminalResources } from "../../../../-terminal-resources";

export type ConnectingViewModel = {
  selectedTerminal: TerminalEndpoint | null;
  selectedSession: TmuxSession | null;
  connectionStep: number;
  onOpenSessionOverview: () => void;
  onBack: () => void;
};

export function useConnectingViewModel(): ConnectingViewModel {
  const navigate = useNavigate();
  const { terminalId, sessionName } = useParams({ from: "/terminals/$terminalId/sessions/$sessionName/connecting/" });
  const { selectedTerminal, selectedSession } = useTerminalResources({ terminalId, sessionName });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void navigate({ to: "/terminals/$terminalId/sessions/$sessionName", params: { terminalId, sessionName } });
    }, 500);
    return () => window.clearTimeout(timer);
  }, [navigate, sessionName, terminalId]);

  return {
    selectedTerminal,
    selectedSession,
    connectionStep: 2,
    onOpenSessionOverview: () => {
      void navigate({ to: "/terminals/$terminalId/sessions/$sessionName", params: { terminalId, sessionName } });
    },
    onBack: () => {
      void navigate({ to: "/terminals/$terminalId/sessions", params: { terminalId } });
    },
  };
}
