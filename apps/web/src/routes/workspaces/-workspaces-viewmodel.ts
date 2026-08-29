import type { WorkspaceDirectory } from "@muximo/contract/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { invalidateWorkspaceData } from "../../app/api/invalidation";
import { muximodErrorMessage } from "../../app/api/muximod-error.js";
import { useMuximodEvents } from "../../app/api/muximod-events";
import { useMuximodConnection } from "../../app/api/use-muximod-connection";

export type WorkspacesStatus = "loading" | "ready" | "error";

export type WorkspacesListViewModel = {
  workspaces: WorkspaceDirectory[];
  status: WorkspacesStatus;
  query: string;
  errorMessage: string | null;
  isRegistering: boolean;
  onQueryChange: (value: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  onRegister: (input: { directory: string; name?: string }) => void;
  onOpenCreate: () => void;
  onBack: () => void;
};

export type WorkspaceDetailViewModel = {
  workspace: WorkspaceDirectory | null;
  workspaces: WorkspaceDirectory[];
  status: WorkspacesStatus;
  name: string;
  setupScriptPath: string;
  cleanupScriptPath: string;
  worktreeCopyPatterns: string;
  isSaving: boolean;
  isDeleting: boolean;
  errorMessage: string | null;
  saveError: string | null;
  canSave: boolean;
  onNameChange: (value: string) => void;
  onSetupScriptPathChange: (value: string) => void;
  onCleanupScriptPathChange: (value: string) => void;
  onWorktreeCopyPatternsChange: (value: string) => void;
  onSave: () => void;
  onDelete: () => void;
  onBack: () => void;
};

export function filterWorkspaces(workspaces: WorkspaceDirectory[], query: string): WorkspaceDirectory[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return workspaces;
  return workspaces.filter(
    (workspace) => workspace.name.toLowerCase().includes(needle) || workspace.directory.toLowerCase().includes(needle),
  );
}

export function workspaceDetailCanSave(name: string): boolean {
  return name.trim().length > 0 && name.trim().length <= 120 && !/[\u0000\r\n\t]/.test(name);
}

export function parseWorktreeCopyPatterns(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((pattern) => pattern.trim())
        .filter(Boolean),
    ),
  ];
}

export function useWorkspacesListViewModel(): WorkspacesListViewModel {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { connection, utils } = useMuximodConnection();
  useMuximodEvents(connection);
  const [query, setQuery] = useState("");
  const workspacesQuery = useQuery(
    utils.workspaces.list.queryOptions({
      input: {},
      staleTime: 5_000,
      enabled: Boolean(connection),
    }),
  );
  const registerMutation = useMutation({
    mutationFn: (input: { directory: string; name?: string }) => {
      if (!connection) throw new Error("Connection profile is not configured");
      return utils.workspaces.register.call(input, {});
    },
    onSuccess: (response) => {
      const workspace = response.workspace;
      invalidateWorkspaceData(queryClient, utils);
      void navigate({ to: "/workspaces/$workspaceId", params: { workspaceId: workspace.id } });
    },
  });

  return {
    workspaces: workspacesQuery.data?.workspaces ?? [],
    status: workspacesQuery.status === "pending" ? "loading" : workspacesQuery.status === "error" ? "error" : "ready",
    query,
    errorMessage: errorMessage(workspacesQuery.error),
    isRegistering: registerMutation.isPending,
    onQueryChange: setQuery,
    onSelectWorkspace: (workspaceId) => {
      void navigate({ to: "/workspaces/$workspaceId", params: { workspaceId } });
    },
    onRegister: (input) => registerMutation.mutate(input),
    onOpenCreate: () => {
      const directory = window.prompt("Workspace directory (host absolute path)");
      if (directory?.trim()) registerMutation.mutate({ directory: directory.trim() });
    },
    onBack: () => {
      void navigate({ to: "/terminals" });
    },
  };
}

function errorMessage(error: unknown): string | null {
  return error ? muximodErrorMessage(error) : null;
}
