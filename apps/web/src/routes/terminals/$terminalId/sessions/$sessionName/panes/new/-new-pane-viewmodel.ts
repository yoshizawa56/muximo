import type { PanePlacement, PaneSummary, TerminalEndpoint, TmuxSession } from "@muximo/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { invalidateSessionData } from "../../../../../../../app/api/invalidation";
import { muximodErrorMessage } from "../../../../../../../app/api/muximod-error.js";
import { useMuximodConnection } from "../../../../../../../app/api/use-muximod-connection";
import { fallbackSession, fallbackTerminal, useTerminalResources } from "../../../../../-terminal-resources";
import {
  useWorkspacePickerViewModel,
  type WorkspacePickerViewModel,
  workspacePickerState,
} from "../../../-workspace-picker-viewmodel";
import type { NewPaneAgent } from "./-agent-options";

export type NewPaneKind = "agent" | "shell";
export type { NewPaneAgent } from "./-agent-options";

export type NewPaneViewModel = {
  terminal: TerminalEndpoint;
  session: TmuxSession;
  name: string;
  workspacePicker: WorkspacePickerViewModel;
  kind: NewPaneKind;
  agentId: NewPaneAgent;
  existingPanes: PaneSummary[];
  placement: PanePlacement;
  targetPaneId: string | null;
  isCreating: boolean;
  errorMessage: string | null;
  onNameChange: (value: string) => void;
  onKindChange: (value: NewPaneKind) => void;
  onAgentChange: (value: NewPaneAgent) => void;
  onPlacementChange: (value: PanePlacement) => void;
  onTargetPaneChange: (value: string) => void;
  onCreate: () => void;
  onBack: () => void;
};

export function useNewPaneViewModel(): NewPaneViewModel {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { terminalId, sessionName } = useParams({ from: "/terminals/$terminalId/sessions/$sessionName/panes/new/" });
  const { connection } = useMuximodConnection();
  const resources = useTerminalResources({ terminalId, sessionName });
  const workspacePicker = useWorkspacePickerViewModel({ initialMode: "worktree" });
  const scopedSessionName = resources.selectedSession?.name ?? sessionName;
  const panesQuery = useQuery(
    resources.utils.panes.list.queryOptions({
      input: scopedSessionName ? { session: scopedSessionName } : {},
      enabled: Boolean(connection) && Boolean(sessionName),
      staleTime: 1_000,
    }),
  );
  const existingPanes = panesQuery.data?.panes ?? [];
  const [name, setName] = useState("");
  const [kind, setKind] = useState<NewPaneKind>("agent");
  const [agentId, setAgentId] = useState<NewPaneAgent>("codex");
  const [placement, setPlacement] = useState<PanePlacement>("window");
  const [targetPaneId, setTargetPaneId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (placement !== "window" && !targetPaneId) setTargetPaneId(existingPanes[0]?.tmuxPaneId ?? null);
  }, [existingPanes, placement, targetPaneId]);

  useEffect(() => {
    if (kind === "agent" && workspacePicker.mode === "worktree" && workspacePicker.workspaces.length) {
      const selected =
        workspacePicker.workspaces.find((workspace) => workspace.id === workspacePicker.workspaceId) ??
        workspacePicker.workspaces[0];
      if (!selected?.isGit) workspacePicker.onModeChange("workspace");
    }
  }, [kind, workspacePicker]);

  return {
    terminal: resources.selectedTerminal ?? fallbackTerminal,
    session: resources.selectedSession ?? fallbackSession,
    name,
    workspacePicker,
    kind,
    agentId,
    existingPanes,
    placement,
    targetPaneId,
    isCreating,
    errorMessage,
    onNameChange: setName,
    onKindChange: (nextKind) => {
      setKind(nextKind);
      if (nextKind === "shell") {
        workspacePicker.onModeChange("workspace");
        return;
      }
      const selected =
        workspacePicker.workspaces.find((workspace) => workspace.id === workspacePicker.workspaceId) ??
        workspacePicker.workspaces[0];
      if (selected?.isGit) workspacePicker.onModeChange("worktree");
    },
    onAgentChange: setAgentId,
    onPlacementChange: (nextPlacement) => {
      setPlacement(nextPlacement);
      if (nextPlacement !== "window" && !targetPaneId) setTargetPaneId(existingPanes[0]?.tmuxPaneId ?? null);
    },
    onTargetPaneChange: setTargetPaneId,
    onCreate: () => {
      const useWorktree = workspacePicker.mode === "worktree";
      const workspaceRequired = useWorktree || (kind === "agent" && placement === "window");
      const workspaceId = workspaceRequired ? workspacePicker.workspaceId || existingPanes[0]?.workspaceId : undefined;
      if (
        !connection ||
        !resources.selectedSession ||
        !name.trim() ||
        (workspaceRequired && (!workspaceId || !workspacePickerState(workspacePicker).canContinue)) ||
        (placement !== "window" && !targetPaneId) ||
        isCreating
      )
        return;
      setIsCreating(true);
      setErrorMessage(null);
      const selectedSession = resources.selectedSession;
      if (!selectedSession) return;
      void resources.utils.panes.create
        .call(
          {
            sessionName: selectedSession.name,
            kind,
            name: name.trim(),
            ...(workspaceId ? { workspaceId } : {}),
            agentId: kind === "agent" ? agentId : null,
            useWorktree,
            placement,
            targetPaneId: placement === "window" ? null : targetPaneId,
          },
          {},
        )
        .then((response) => {
          const pane = response.pane;
          queryClient.setQueryData(
            resources.utils.panes.list.queryKey({ input: scopedSessionName ? { session: scopedSessionName } : {} }),
            (current) => {
              if (!current) return current;
              const panes = [...current.panes.filter((candidate) => candidate.id !== pane.id), pane];
              return { ...current, panes };
            },
          );
          invalidateSessionData(queryClient, resources.utils);
          void navigate({
            to: "/terminals/$terminalId/sessions/$sessionName/panes/$paneId",
            params: { terminalId, sessionName: selectedSession.name, paneId: pane.id },
          });
        })
        .catch((error: unknown) => setErrorMessage(muximodErrorMessage(error)))
        .finally(() => setIsCreating(false));
    },
    onBack: () => {
      void navigate({ to: "/terminals/$terminalId/sessions/$sessionName", params: { terminalId, sessionName } });
    },
  };
}
