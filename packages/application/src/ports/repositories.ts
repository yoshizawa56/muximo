import type {
  AgentSessionId,
  AgentSessionRecord,
  PaneId,
  PaneRecord,
  WorkspaceId,
  WorkspaceRecord,
} from "@muximo/domain";
import type { PaneFilter } from "../models/panes.js";

export interface PaneRepository {
  list(filter?: PaneFilter): Promise<PaneRecord[]>;
  findById(id: PaneId): Promise<PaneRecord | undefined>;
  findByTmuxPaneId(tmuxPaneId: string): Promise<PaneRecord | undefined>;
  findByTmuxPaneIdentity(tmuxServerId: string, tmuxPaneId: string): Promise<PaneRecord | undefined>;
  upsert(record: PaneRecord): Promise<void>;
  pruneStalePanes(activePaneIds: readonly PaneId[], olderThan: string, tmuxServerScope: string): Promise<number>;
}

export interface WorkspaceRepository {
  findById(id: WorkspaceId): Promise<WorkspaceRecord | undefined>;
  list(): Promise<WorkspaceRecord[]>;
  insert(record: WorkspaceRecord): Promise<boolean>;
  upsert(record: WorkspaceRecord): Promise<void>;
  delete(id: WorkspaceId): Promise<void>;
}

export interface AgentSessionRepository {
  findById(id: AgentSessionId): Promise<AgentSessionRecord | undefined>;
  findByName(workspaceId: WorkspaceId, name: string): Promise<AgentSessionRecord | undefined>;
  list(workspaceId?: WorkspaceId): Promise<AgentSessionRecord[]>;
  insert(record: AgentSessionRecord): Promise<void>;
  update(record: AgentSessionRecord): Promise<void>;
  claimExecution(
    id: AgentSessionId,
    expectedExecutionPid: number | null,
    executionId: string,
    executionPid: number,
    executionStartedAt: string,
  ): Promise<boolean>;
  setBackendSessionIdIfMissing(id: AgentSessionId, backendSessionId: string): Promise<boolean>;
  delete(id: AgentSessionId): Promise<void>;
}
