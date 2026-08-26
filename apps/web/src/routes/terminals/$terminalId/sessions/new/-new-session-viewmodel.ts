import type { TerminalEndpoint } from "@muximo/contract";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useState } from "react";
import { invalidateSessionData } from "../../../../../app/api/invalidation";
import { muximodErrorMessage } from "../../../../../app/api/muximod-error.js";
import { useMuximodConnection } from "../../../../../app/api/use-muximod-connection";
import { fallbackTerminal, useTerminalResources } from "../../../-terminal-resources";
import {
  useWorkspacePickerViewModel,
  type WorkspacePickerViewModel,
  workspacePickerState,
} from "../-workspace-picker-viewmodel";

export type NewSessionViewModel = {
  terminal: TerminalEndpoint;
  name: string;
  workspacePicker: WorkspacePickerViewModel;
  isCreating?: boolean;
  errorMessage?: string | null;
  onNameChange: (value: string) => void;
  onBack: () => void;
  onCreate: () => void;
};

export function useNewSessionViewModel(): NewSessionViewModel {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { terminalId } = useParams({ from: "/terminals/$terminalId/sessions/new/" });
  const { connection, utils } = useMuximodConnection();
  const { selectedTerminal } = useTerminalResources({ terminalId });
  const workspacePicker = useWorkspacePickerViewModel();
  const [name, setName] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  return {
    terminal: selectedTerminal ?? fallbackTerminal,
    name,
    workspacePicker,
    isCreating,
    errorMessage,
    onNameChange: setName,
    onBack: () => {
      void navigate({ to: "/terminals/$terminalId/sessions", params: { terminalId } });
    },
    onCreate: () => {
      const workspaceId = workspacePicker.workspaceId;
      if (
        !connection ||
        !name.trim() ||
        !workspacePickerState(workspacePicker).canContinue ||
        !workspaceId ||
        isCreating
      )
        return;
      setIsCreating(true);
      setErrorMessage(null);
      void utils.sessions.create
        .call({ name: name.trim(), workspaceId }, {})
        .then((response) => {
          const session = response.session;
          queryClient.setQueryData(utils.sessions.list.queryKey({ input: {} }), (current) => {
            if (!current) return current;
            const sessions = [...current.sessions.filter((candidate) => candidate.name !== session.name), session];
            return { ...current, sessions };
          });
          invalidateSessionData(queryClient, utils);
          void navigate({
            to: "/terminals/$terminalId/sessions/$sessionName",
            params: { terminalId, sessionName: session.name },
          });
        })
        .catch((error: unknown) => setErrorMessage(muximodErrorMessage(error)))
        .finally(() => setIsCreating(false));
    },
  };
}
