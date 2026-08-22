import { useNavigate, useParams } from "@tanstack/react-router";
import type { TmuxSession } from "@muximo/contract";
import type { TerminalEndpoint } from "../../../../-connection-flow-viewmodel";
import { useTerminalResources } from "../../../../-terminal-resources";

export type DisconnectedViewModel = {
  selectedTerminal: TerminalEndpoint | null;
  selectedSession: TmuxSession | null;
  onReconnect: () => void;
  onChooseTerminal: () => void;
};

export function useDisconnectedViewModel(): DisconnectedViewModel {
  const navigate = useNavigate();
  const { terminalId, sessionName } = useParams({ from: "/terminals/$terminalId/sessions/$sessionName/disconnected/" });
  const { selectedTerminal, selectedSession } = useTerminalResources({ terminalId, sessionName });
  return {
    selectedTerminal,
    selectedSession,
    onReconnect: () => {
      void navigate({ to: "/terminals/$terminalId/sessions/$sessionName/connecting", params: { terminalId, sessionName } });
    },
    onChooseTerminal: () => {
      void navigate({ to: "/terminals" });
    },
  };
}
