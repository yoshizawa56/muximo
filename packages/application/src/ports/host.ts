import type { AgentSession, PaneKind, PaneState } from "@muximo/domain";

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

export type AgentExecutionObservation = Pick<AgentSession, "status" | "executionPid"> & {
  state?: PaneState;
};
