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
  executionPid: number;
  executionStartedAt: string;
  updatedAt: string;
};

export interface AgentSessionRepository {
  findById(id: AgentSessionId): Promise<AgentSessionRecord | undefined>;
  findByName(workspaceId: WorkspaceId, name: string): Promise<AgentSessionRecord | undefined>;
  list(workspaceId?: WorkspaceId): Promise<AgentSessionRecord[]>;
  insert(record: AgentSessionRecord): Promise<void>;
  update(record: AgentSessionRecord): Promise<void>;
  claimExecution(input: ClaimExecutionInput): Promise<boolean>;
  setBackendSessionIdIfMissing(id: AgentSessionId, backendSessionId: string): Promise<boolean>;
  delete(id: AgentSessionId): Promise<void>;
}
