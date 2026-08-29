import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { invalidateWorkspaceData } from "../../../app/api/invalidation";
import { muximodErrorMessage } from "../../../app/api/muximod-error.js";
import { useMuximodEvents } from "../../../app/api/muximod-events";
import { useMuximodConnection } from "../../../app/api/use-muximod-connection";
import { type WorkspaceDetailViewModel, workspaceDetailCanSave } from "../-workspaces-viewmodel";

export function useWorkspaceDetailViewModel(workspaceId: string): WorkspaceDetailViewModel {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { connection: muximodConnection, utils } = useMuximodConnection();
  useMuximodEvents(muximodConnection);

  const workspacesQuery = useQuery(
    utils.workspaces.list.queryOptions({
      input: {},
      staleTime: 5_000,
      enabled: Boolean(muximodConnection),
    }),
  );

  const workspace = useMemo(
    () => (workspacesQuery.data?.workspaces ?? []).find((w) => w.id === workspaceId) ?? null,
    [workspacesQuery.data, workspaceId],
  );

  const [name, setName] = useState("");
  const [setupScriptPath, setSetupScriptPath] = useState("");
  const [cleanupScriptPath, setCleanupScriptPath] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    setName(workspace.name);
    setSetupScriptPath(workspace.setupScriptPath ?? "");
    setCleanupScriptPath(workspace.cleanupScriptPath ?? "");
    setSaveError(null);
  }, [workspace]);

  const updateMutation = useMutation({
    mutationFn: () => {
      if (!muximodConnection) throw new Error("Connection profile is not configured");
      return utils.workspaces.update.call(
        {
          workspaceId,
          input: {
            name: name.trim() || undefined,
            setupScriptPath: setupScriptPath.trim() ? setupScriptPath.trim() : null,
            cleanupScriptPath: cleanupScriptPath.trim() ? cleanupScriptPath.trim() : null,
          },
        },
        {},
      );
    },
    onSuccess: () => {
      invalidateWorkspaceData(queryClient, utils);
      setSaveError(null);
    },
    onError: (error: unknown) => setSaveError(muximodErrorMessage(error)),
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!muximodConnection) throw new Error("Connection profile is not configured");
      return utils.workspaces.delete.call({ workspaceId }, {});
    },
    onSuccess: () => {
      invalidateWorkspaceData(queryClient, utils);
      void navigate({ to: "/workspaces" });
    },
    onError: (error: unknown) => setSaveError(muximodErrorMessage(error)),
  });

  const onSave = useCallback(() => {
    if (!workspaceDetailCanSave(name)) {
      setSaveError("Workspace name cannot be empty or exceed 120 characters");
      return;
    }
    updateMutation.mutate();
  }, [name, updateMutation]);

  const onDelete = useCallback(() => {
    if (!window.confirm(`Unregister workspace "${workspace?.name ?? workspaceId}"? Directory will not be deleted.`))
      return;
    deleteMutation.mutate();
  }, [workspace, workspaceId, deleteMutation]);

  const onBack = useCallback(() => {
    void navigate({ to: "/workspaces" });
  }, [navigate]);

  return {
    workspace,
    workspaces: workspacesQuery.data?.workspaces ?? [],
    status: workspacesQuery.status === "pending" ? "loading" : workspacesQuery.status === "error" ? "error" : "ready",
    name,
    setupScriptPath,
    cleanupScriptPath,
    isSaving: updateMutation.isPending,
    isDeleting: deleteMutation.isPending,
    errorMessage: workspacesQuery.error ? muximodErrorMessage(workspacesQuery.error) : null,
    saveError,
    canSave: workspaceDetailCanSave(name),
    onNameChange: setName,
    onSetupScriptPathChange: setSetupScriptPath,
    onCleanupScriptPathChange: setCleanupScriptPath,
    onSave,
    onDelete,
    onBack,
  };
}
