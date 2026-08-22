import type { AgentBackend, AgentSessionRecord, PaneState, WorkspaceId, WorkspaceRecord } from "@muximo/domain";
import type { CreatePaneInput, MuximodPanePlacement, MuximodWorkspaceDirectory } from "../models/muximod.js";
import type { WorkspaceDirectoryPort } from "./workspace.js";

export type MuximodPaneRef = {
  paneId: string;
  windowId: string;
  sessionName: string;
};

export type MuximodPaneSnapshot = MuximodPaneRef & {
  tmuxServerId?: string;
  muximodSessionId?: string;
  muximodExecutionId?: string;
  windowName: string;
  windowIndex: number;
  paneIndex: number;
  cwd: string;
  command: string;
  title: string;
  active: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
  muximodPaneId?: string;
  muximodName?: string;
  muximodKind?: string;
  muximodAgentId?: string;
  muximodWorkspaceId?: string;
  muximodManagedSessionId?: string;
};

export type MuximodLiveSnapshot = {
  panes: MuximodPaneSnapshot[];
  available: boolean;
  tmuxServerId: string | null;
  tmuxServerScope: string | null;
};

/** Host operations required by muximod use cases. */
export interface MuximodHostPort {
  newId(): string;
  hasSession(target: string): boolean;
  createManagedSession(target: string, cwd: string): string;
  killSession(target: string): void;
  attachSession(target: string): number;
  createManagedPane(input: CreatePaneInput, workspace: WorkspaceRecord | undefined, cwd: string | undefined): string;
  resolvePane(target: string): MuximodPaneRef;
  isWindowZoomed(pane: MuximodPaneRef): boolean;
  splitPane(
    command: string | undefined,
    placement: Exclude<MuximodPanePlacement, "window">,
    targetPaneId: string,
    zoomed: boolean,
  ): string;
  listPanesSnapshot(): MuximodLiveSnapshot;
  setAgentPaneMetadata(
    paneId: string,
    field: "pane_id" | "pane_name" | "kind" | "agent_id" | "workspace_id" | "managed_session_id",
    value: string,
  ): void;
  setAgentExecutionMetadata(paneId: string, agentSessionId: string, executionId: string): void;
  clearAgentExecutionMetadata(paneId: string, expectedExecutionId?: string): boolean;
  resetAgentPaneMetadata(paneId: string): void;
  capturePane(paneId: string, lines?: number): string;
  isManagedMuximoCommand(command: string, backend: AgentBackend): boolean;
  isProcessAlive(pid: number): boolean;
}

export interface MuximodViewportPort {
  handleTmuxHook(
    event: "client-attached" | "client-active" | "client-resized" | "client-focus-in" | "client-detached",
    client: string,
  ): void;
  reassertMobileViewport(target: string): void;
}

export interface MuximodWorkspaceCatalogPort extends WorkspaceDirectoryPort {
  toDirectoryOption(workspace: WorkspaceRecord): MuximodWorkspaceDirectory;
  browseDirectories(parentPath?: string): Promise<MuximodWorkspaceDirectory[]>;
  resolveLegacyDirectory(directory: string): Promise<string>;
  resolveWorkspaceDirectory(
    workspaceId: WorkspaceId,
    findWorkspace: (id: WorkspaceId) => Promise<WorkspaceRecord | undefined>,
  ): Promise<WorkspaceRecord>;
  resolveSelection(
    selection: { workspaceId: WorkspaceId; mode: "workspace" | "worktree" },
    findWorkspace: (id: WorkspaceId) => Promise<WorkspaceRecord | undefined>,
  ): Promise<WorkspaceRecord>;
}

export type AgentExecutionObservation = Pick<AgentSessionRecord, "status" | "executionPid"> & {
  state?: PaneState;
};
