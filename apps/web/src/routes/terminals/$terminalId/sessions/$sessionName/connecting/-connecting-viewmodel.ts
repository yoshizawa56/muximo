import type { TerminalEndpoint, TmuxSession } from "@muximo/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { invalidateSessionData } from "../../../../../../app/api/invalidation";
import { useTerminalResources } from "../../../../-terminal-resources";

export type ConnectingViewModel = {
  selectedTerminal: TerminalEndpoint | null;
  selectedSession: TmuxSession | null;
  connectionStep: number;
  isManaging: boolean;
  errorMessage: string | null;
  onOpenSessionOverview: () => void;
  onBack: () => void;
};

export function useConnectingViewModel(): ConnectingViewModel {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { terminalId, sessionName } = useParams({ from: "/terminals/$terminalId/sessions/$sessionName/connecting/" });
  const { connection, utils, selectedTerminal, selectedSession } = useTerminalResources({ terminalId, sessionName });
  const [isManaging, setIsManaging] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const latestRetryToken = useRef(0);
  latestRetryToken.current = retryToken;

  useEffect(() => {
    if (!connection || !selectedSession) return;

    let cancelled = false;
    let timer: number | undefined;
    const requestAttempt = retryToken;
    const openSessionOverview = () => {
      if (!cancelled)
        void navigate({ to: "/terminals/$terminalId/sessions/$sessionName", params: { terminalId, sessionName } });
    };
    const scheduleOpen = () => {
      timer = window.setTimeout(openSessionOverview, 500);
    };

    if (selectedSession.managed) {
      scheduleOpen();
    } else {
      setIsManaging(true);
      setErrorMessage(null);
      void utils.sessions.manage
        .call({ name: selectedSession.name }, {})
        .then(() => {
          if (cancelled || latestRetryToken.current !== requestAttempt) return;
          invalidateSessionData(queryClient, utils);
          setIsManaging(false);
          scheduleOpen();
        })
        .catch((error: unknown) => {
          if (cancelled || latestRetryToken.current !== requestAttempt) return;
          setIsManaging(false);
          setErrorMessage(error instanceof Error ? error.message : String(error));
        });
    }

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [connection, navigate, queryClient, retryToken, selectedSession, sessionName, terminalId, utils]);

  return {
    selectedTerminal,
    selectedSession,
    connectionStep: 2,
    isManaging,
    errorMessage,
    onOpenSessionOverview: () => {
      if (isManaging) return;
      if (errorMessage && selectedSession && !selectedSession.managed) {
        setRetryToken((value) => value + 1);
        return;
      }
      void navigate({ to: "/terminals/$terminalId/sessions/$sessionName", params: { terminalId, sessionName } });
    },
    onBack: () => {
      void navigate({ to: "/terminals/$terminalId/sessions", params: { terminalId } });
    },
  };
}
