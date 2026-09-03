import type { AgentSession, AgentSessionId, Pane, PaneId, PaneState, Workspace, WorkspaceId } from "@muximo/domain";
import type { ApplicationEffect } from "../effect.js";

export type PaneFilter = {
  state?: PaneState;
  kind?: Pane["kind"];
  sessionName?: string;
};

export interface PaneRepository {
  list(filter?: PaneFilter): ApplicationEffect<Pane[]>;
  findById(id: PaneId): ApplicationEffect<Pane | undefined>;
  findByHostPaneIdentity(hostServerId: string, hostPaneId: string): ApplicationEffect<Pane | undefined>;
  upsert(record: Pane): ApplicationEffect<void>;
  pruneStalePanes(
    activePaneIds: readonly PaneId[],
    olderThan: string,
    hostServerScope: string,
  ): ApplicationEffect<number>;
}

export interface WorkspaceRepository {
  findById(id: WorkspaceId): ApplicationEffect<Workspace | undefined>;
  list(): ApplicationEffect<Workspace[]>;
  insert(record: Workspace): ApplicationEffect<boolean>;
  upsert(record: Workspace): ApplicationEffect<void>;
  delete(id: WorkspaceId): ApplicationEffect<void>;
}

export type ClaimExecutionInput = {
  id: AgentSessionId;
  expectedExecutionPid: number | null;
  executionId: string;
  executionPid: number | null;
  executionStartedAt: string;
  executionOwnerPid: number | null;
  executionOwnerStartedAt: string | null;
  lastActivityAt: string;
};

export type AttachExecutionInput = {
  id: AgentSessionId;
  executionId: string;
  expectedExecutionOwnerPid: number | null;
  expectedExecutionOwnerStartedAt: string | null;
  executionPid: number;
  executionStartedAt: string;
  lastActivityAt: string;
};

export type ClaimAbandonedExecutionInput = {
  id: AgentSessionId;
  executionId: string;
  expectedExecutionPid: number | null;
  expectedExecutionStartedAt: string | null;
  expectedExecutionOwnerPid: number | null;
  expectedExecutionOwnerStartedAt: string | null;
  lastActivityAt: string;
};

export interface AgentSessionRepository {
  findById(id: AgentSessionId): ApplicationEffect<AgentSession | undefined>;
  findByName(workspaceId: WorkspaceId, name: string): ApplicationEffect<AgentSession | undefined>;
  list(workspaceId?: WorkspaceId): ApplicationEffect<AgentSession[]>;
  insert(record: AgentSession): ApplicationEffect<void>;
  update(record: AgentSession): ApplicationEffect<void>;
  claimExecution(input: ClaimExecutionInput): ApplicationEffect<boolean>;
  claimAbandonedExecution(input: ClaimAbandonedExecutionInput): ApplicationEffect<boolean>;
  attachExecution(input: AttachExecutionInput): ApplicationEffect<boolean>;
  setBackendSessionIdIfMissing(id: AgentSessionId, backendSessionId: string): ApplicationEffect<boolean>;
  delete(id: AgentSessionId): ApplicationEffect<void>;
}
