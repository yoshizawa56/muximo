import type { WorkspaceDirectory } from "@muximo/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { invalidateWorkspaceData } from "../../../../app/api/invalidation";
import { useMuximodConnection } from "../../../../app/api/use-muximod-connection";

export type WorkspacePickerStatus = "loading" | "ready" | "error";
export type WorkspaceSelectionMode = "workspace" | "worktree";

export type WorkspacePickerInput = {
  workspaces: WorkspaceDirectory[];
  workspaceCandidates: WorkspaceDirectory[];
  workspaceId: string;
  mode: WorkspaceSelectionMode;
  workspaceStatus: WorkspacePickerStatus;
  browserStatus: WorkspacePickerStatus;
  browserPath: string | null;
  registrationOpen: boolean;
  registrationDirectory: string;
  setupScriptPath: string;
  cleanupScriptPath: string;
  worktreeCopyPatterns: string;
  isRegisteringWorkspace: boolean;
  registrationError: string | null;
  errorMessage: string | null;
};

export type WorkspacePickerState = {
  selectedWorkspace: WorkspaceDirectory | null;
  canContinue: boolean;
  modeHelp: string;
};

export type WorkspacePickerViewModel = WorkspacePickerInput & {
  onWorkspaceChange: (workspaceId: string) => void;
  onModeChange: (mode: WorkspaceSelectionMode) => void;
  onOpenRegistration: () => void;
  onCloseRegistration: () => void;
  onBrowseWorkspace: (path?: string) => void;
  onSelectWorkspaceDirectory: (directory: string) => void;
  onRegistrationDirectoryChange: (directory: string) => void;
  onSetupScriptPathChange: (path: string) => void;
  onCleanupScriptPathChange: (path: string) => void;
  onWorktreeCopyPatternsChange: (patterns: string) => void;
  onRegisterWorkspace: () => void;
};

export function workspacePickerState(input: WorkspacePickerInput): WorkspacePickerState {
  const selectedWorkspace = input.workspaces.find((workspace) => workspace.id === input.workspaceId) ?? null;
  const canContinue =
    input.workspaceStatus === "ready" &&
    Boolean(selectedWorkspace) &&
    (input.mode === "workspace" || Boolean(selectedWorkspace?.isGit));

  return {
    selectedWorkspace,
    canContinue,
    modeHelp:
      input.mode === "worktree"
        ? "The host creates an isolated git worktree and runs the registered workspace hooks with the worktree as cwd."
        : "Open the selected workspace directory directly.",
  };
}

export function workspacePickerErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error && typeof error.message === "string")
    return error.message;
  return String(error);
}

export function useWorkspacePickerViewModel({
  initialMode = "workspace",
}: {
  initialMode?: WorkspaceSelectionMode;
} = {}): WorkspacePickerViewModel {
  const queryClient = useQueryClient();
  const { connection, utils } = useMuximodConnection();
  const [workspaceId, setWorkspaceId] = useState("");
  const [mode, setMode] = useState<WorkspaceSelectionMode>(initialMode);
  const [workspaceCandidates, setWorkspaceCandidates] = useState<WorkspaceDirectory[]>([]);
  const [browserPath, setBrowserPath] = useState<string | null>(null);
  const [browserStatus, setBrowserStatus] = useState<WorkspacePickerStatus>("ready");
  const [browserError, setBrowserError] = useState<string | null>(null);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [registrationDirectory, setRegistrationDirectory] = useState("");
  const [setupScriptPath, setSetupScriptPath] = useState("");
  const [cleanupScriptPath, setCleanupScriptPath] = useState("");
  const [worktreeCopyPatterns, setWorktreeCopyPatterns] = useState("");
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [isRegisteringWorkspace, setIsRegisteringWorkspace] = useState(false);

  const workspacesQuery = useQuery(
    utils.workspaces.list.queryOptions({
      input: {},
      staleTime: 5_000,
      retry: 1,
      enabled: Boolean(connection),
    }),
  );
  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const effectiveWorkspaceId = workspaceId || workspaces[0]?.id || "";

  const browseWorkspaceDirectories = useCallback(
    (path?: string) => {
      setBrowserStatus("loading");
      setBrowserError(null);
      if (!connection) {
        setBrowserStatus("error");
        setBrowserError("Connection profile is not configured");
        return;
      }
      void utils.workspaces.browse
        .call(path ? { path } : {}, {})
        .then((response) => {
          setWorkspaceCandidates(response.directories);
          setBrowserPath(path ?? null);
          setBrowserStatus("ready");
        })
        .catch((error: unknown) => {
          setBrowserError(workspacePickerErrorMessage(error) ?? "Could not browse host directories");
          setBrowserStatus("error");
        });
    },
    [connection, utils],
  );

  const onRegisterWorkspace = useCallback(() => {
    const directory = registrationDirectory.trim();
    if (!directory || isRegisteringWorkspace || !connection) return;
    setIsRegisteringWorkspace(true);
    setRegistrationError(null);
    void utils.workspaces.register
      .call(
        {
          directory,
          setupScriptPath: setupScriptPath.trim() || null,
          cleanupScriptPath: cleanupScriptPath.trim() || null,
          worktreeCopyPatterns: [
            ...new Set(
              worktreeCopyPatterns
                .split(/\r?\n/)
                .map((pattern) => pattern.trim())
                .filter(Boolean),
            ),
          ],
        },
        {},
      )
      .then((response) => {
        const workspace = response.workspace;
        invalidateWorkspaceData(queryClient, utils);
        setWorkspaceId(workspace.id);
        setRegistrationOpen(false);
        setRegistrationError(null);
      })
      .catch((error: unknown) =>
        setRegistrationError(workspacePickerErrorMessage(error) ?? "Could not register workspace"),
      )
      .finally(() => setIsRegisteringWorkspace(false));
  }, [
    connection,
    isRegisteringWorkspace,
    queryClient,
    registrationDirectory,
    setupScriptPath,
    cleanupScriptPath,
    worktreeCopyPatterns,
    utils,
  ]);

  return {
    workspaces,
    workspaceCandidates,
    workspaceId: effectiveWorkspaceId,
    mode,
    workspaceStatus: queryStatus(workspacesQuery.status),
    browserStatus,
    browserPath,
    registrationOpen,
    registrationDirectory,
    setupScriptPath,
    cleanupScriptPath,
    worktreeCopyPatterns,
    isRegisteringWorkspace,
    registrationError,
    errorMessage: workspacePickerErrorMessage(workspacesQuery.error) ?? browserError,
    onWorkspaceChange: setWorkspaceId,
    onModeChange: setMode,
    onOpenRegistration: () => {
      setRegistrationOpen(true);
      setRegistrationError(null);
      if (browserStatus !== "ready" || !workspaceCandidates.length) browseWorkspaceDirectories();
    },
    onCloseRegistration: () => setRegistrationOpen(false),
    onBrowseWorkspace: browseWorkspaceDirectories,
    onSelectWorkspaceDirectory: setRegistrationDirectory,
    onRegistrationDirectoryChange: setRegistrationDirectory,
    onSetupScriptPathChange: setSetupScriptPath,
    onCleanupScriptPathChange: setCleanupScriptPath,
    onWorktreeCopyPatternsChange: setWorktreeCopyPatterns,
    onRegisterWorkspace,
  };
}

function queryStatus(status: "pending" | "error" | "success"): WorkspacePickerStatus {
  return status === "pending" ? "loading" : status === "error" ? "error" : "ready";
}
