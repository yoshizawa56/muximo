import type {
  AgentBackend,
  AgentSessionRecord,
  PaneKind,
  PaneState,
  WorkspaceId,
  WorkspaceRecord,
} from "@muximo/domain";
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

/** Provider-neutral terminal observation and classification owned by application. */
export interface MuximodTerminalObservationPort {
  classifyCommand(command: string): Promise<MuximodPaneClassification>;
  observeUnmanagedAgent(paneId: string, fallbackState: PaneState): Promise<MuximodPaneObservation>;
  isManagedAgentExecution(command: string, backend: AgentBackend): Promise<boolean>;
}

/** Host operations required by muximod use cases. */
export interface MuximodHostPort extends MuximodTerminalObservationPort {
  /** UUID generation is local identity construction and has no host I/O. */
  newId(): string;
  hasSession(target: string): Promise<boolean>;
  createManagedSession(target: string, cwd: string): Promise<string>;
  killSession(target: string): Promise<void>;
  attachSession(target: string): Promise<number>;
  createManagedPane(
    input: CreatePaneInput,
    workspace: WorkspaceRecord | undefined,
    cwd: string | undefined,
  ): Promise<string>;
  resolvePane(target: string): Promise<HostPaneReference>;
  isWindowZoomed(pane: HostPaneReference): Promise<boolean>;
  splitPane(
    command: string | undefined,
    placement: Exclude<MuximodPanePlacement, "window">,
    targetPaneId: string,
    zoomed: boolean,
  ): Promise<string>;
  listPanesSnapshot(): Promise<TerminalHostSnapshot>;
  setAgentPaneMetadata(
    paneId: string,
    field: "pane_id" | "pane_name" | "kind" | "agent_id" | "workspace_id" | "managed_session_id",
    value: string,
  ): Promise<void>;
  setAgentExecutionMetadata(paneId: string, agentSessionId: string, executionId: string): Promise<void>;
  clearAgentExecutionMetadata(paneId: string, expectedExecutionId?: string): Promise<boolean>;
  resetAgentPaneMetadata(paneId: string): Promise<void>;
  isProcessAlive(pid: number): Promise<boolean>;
}

export interface MuximodViewportPort {
  handleTerminalHostHook(
    event: "client-attached" | "client-active" | "client-resized" | "client-focus-in" | "client-detached",
    client: string,
  ): Promise<void>;
  reassertMobileViewport(target: string): Promise<void>;
}

export interface MuximodWorkspaceCatalogPort extends WorkspaceDirectoryPort {
  toDirectoryOption(workspace: WorkspaceRecord): MuximodWorkspaceDirectory;
  browseDirectories(parentPath?: string): Promise<MuximodWorkspaceDirectory[]>;
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
