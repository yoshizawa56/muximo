import type { AgentSession, PaneKind, PaneState, Workspace, WorkspaceId } from "@muximo/domain";
import type { ApplicationEffect } from "../effect.js";
import type { CreatePaneInput, MuximodPanePlacement, MuximodWorkspaceDirectory } from "./application.js";
import type { WorkspaceDirectoryPort } from "./workspace.js";

export type HostPaneReference = {
  hostPaneId: string;
  windowId: string;
  sessionName: string;
};

export type HostPaneSnapshot = HostPaneReference & {
  hostServerId: string;
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

export type TerminalHostSnapshot = {
  panes: HostPaneSnapshot[];
  available: boolean;
  hostServerId: string | null;
  hostServerScope: string | null;
};

export type MuximodPaneClassification = {
  kind: PaneKind;
  agentId?: string;
};

export type MuximodPaneObservation = {
  state: PaneState;
};

/** Host operations required to adopt an existing tmux session. */
export interface MuximodSessionManagementPort {
  /** UUID generation is local identity construction and has no host I/O. */
  newId(): string;
  hasSession(target: string): ApplicationEffect<boolean>;
  findManagedSessionId(target: string): ApplicationEffect<string | undefined>;
  configureManagedSession(target: string, managedSessionId: string): ApplicationEffect<void>;
}

/** Provider-neutral terminal observation and classification owned by application. */
export interface MuximodTerminalObservationPort {
  classifyCommand(command: string): ApplicationEffect<MuximodPaneClassification>;
  observeUnmanagedAgent(paneId: string, fallbackState: PaneState): ApplicationEffect<MuximodPaneObservation>;
}

/** Host operations required by muximod use cases. */
export interface MuximodHostPort extends MuximodTerminalObservationPort {
  /** UUID generation is local identity construction and has no host I/O. */
  newId(): string;
  hasSession(target: string): ApplicationEffect<boolean>;
  createManagedSession(target: string, cwd: string): ApplicationEffect<string>;
  killSession(target: string): ApplicationEffect<void>;
  attachSession(target: string): ApplicationEffect<number>;
  createManagedPane(
    input: CreatePaneInput,
    workspace: Workspace | undefined,
    cwd: string | undefined,
  ): ApplicationEffect<string>;
  resolvePane(target: string): ApplicationEffect<HostPaneReference>;
  isWindowZoomed(pane: HostPaneReference): ApplicationEffect<boolean>;
  splitPane(
    command: string | undefined,
    placement: Exclude<MuximodPanePlacement, "window">,
    targetPaneId: string,
    zoomed: boolean,
  ): ApplicationEffect<string>;
  listPanesSnapshot(): ApplicationEffect<TerminalHostSnapshot>;
  setAgentPaneMetadata(
    paneId: string,
    field: "pane_id" | "pane_name" | "kind" | "agent_id" | "workspace_id" | "managed_session_id",
    value: string,
  ): ApplicationEffect<void>;
  setAgentExecutionMetadata(paneId: string, agentSessionId: string, executionId: string): ApplicationEffect<void>;
  clearAgentExecutionMetadata(paneId: string, expectedExecutionId?: string): ApplicationEffect<boolean>;
  resetAgentPaneMetadata(paneId: string): ApplicationEffect<void>;
  isProcessAlive(pid: number, expectedStartedAt?: string): ApplicationEffect<boolean>;
}

export interface MuximodViewportPort {
  handleTerminalHostHook(
    event: "client-attached" | "client-active" | "client-resized" | "client-focus-in" | "client-detached",
    client: string,
  ): ApplicationEffect<void>;
  reassertMobileViewport(target: string): ApplicationEffect<void>;
}

export interface MuximodWorkspaceCatalogPort extends WorkspaceDirectoryPort {
  toDirectoryOption(workspace: Workspace): MuximodWorkspaceDirectory;
  browseDirectories(parentPath?: string): ApplicationEffect<MuximodWorkspaceDirectory[]>;
  resolveWorkspaceDirectory(
    workspaceId: WorkspaceId,
    findWorkspace: (id: WorkspaceId) => ApplicationEffect<Workspace | undefined>,
  ): ApplicationEffect<Workspace>;
  resolveSelection(
    selection: { workspaceId: WorkspaceId; mode: "workspace" | "worktree" },
    findWorkspace: (id: WorkspaceId) => ApplicationEffect<Workspace | undefined>,
  ): ApplicationEffect<Workspace>;
}

export type AgentExecutionObservation = Pick<AgentSession, "status" | "executionPid"> & {
  state?: PaneState;
};
