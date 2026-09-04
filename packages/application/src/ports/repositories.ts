import type {
  AgentSessionId,
  AgentSessionRecord,
  PaneId,
  PaneRecord,
  PaneState,
  WorkspaceId,
  WorkspaceRecord,
} from "@muximo/domain";

export type PaneFilter = {
  state?: PaneState;
  kind?: PaneRecord["kind"];
  sessionName?: string;
};

export interface PaneRepository {
  list(filter?: PaneFilter): Promise<PaneRecord[]>;
  findById(id: PaneId): Promise<PaneRecord | undefined>;
  findByHostPaneIdentity(hostServerId: string, hostPaneId: string): Promise<PaneRecord | undefined>;
  upsert(record: PaneRecord): Promise<void>;
  touchLastSeen(hostServerId: string, hostPaneIds: readonly string[], lastSeenAt: string): Promise<void>;
  pruneStalePanes(activePaneIds: readonly PaneId[], olderThan: string, hostServerScope: string): Promise<number>;
}

export interface WorkspaceRepository {
  findById(id: WorkspaceId): Promise<WorkspaceRecord | undefined>;
  list(): Promise<WorkspaceRecord[]>;
  insert(record: WorkspaceRecord): Promise<boolean>;
  upsert(record: WorkspaceRecord): Promise<void>;
  delete(id: WorkspaceId): Promise<void>;
}

export type ClaimExecutionInput = {
  id: AgentSessionId;
  expectedExecutionPid: number | null;
  executionId: string;
  executionPid: number | null;
  executionStartedAt: string;
  executionOwnerPid: number | null;
  executionOwnerStartedAt: string | null;
  updatedAt: string;
};

export type AttachExecutionInput = {
  id: AgentSessionId;
  executionId: string;
  expectedExecutionOwnerPid: number | null;
  expectedExecutionOwnerStartedAt: string | null;
  executionPid: number;
  executionStartedAt: string;
  updatedAt: string;
};

export type ClaimAbandonedExecutionInput = {
  id: AgentSessionId;
  executionId: string;
  expectedExecutionPid: number | null;
  expectedExecutionStartedAt: string | null;
  expectedExecutionOwnerPid: number | null;
  expectedExecutionOwnerStartedAt: string | null;
  updatedAt: string;
};

export interface AgentSessionRepository {
  findById(id: AgentSessionId): Promise<AgentSessionRecord | undefined>;
  findByName(workspaceId: WorkspaceId, name: string): Promise<AgentSessionRecord | undefined>;
  list(workspaceId?: WorkspaceId): Promise<AgentSessionRecord[]>;
  insert(record: AgentSessionRecord): Promise<void>;
  update(record: AgentSessionRecord): Promise<void>;
  claimExecution(input: ClaimExecutionInput): Promise<boolean>;
  claimAbandonedExecution(input: ClaimAbandonedExecutionInput): Promise<boolean>;
  attachExecution(input: AttachExecutionInput): Promise<boolean>;
  setBackendSessionIdIfMissing(id: AgentSessionId, backendSessionId: string): Promise<boolean>;
  delete(id: AgentSessionId): Promise<void>;
}
