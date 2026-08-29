import type {
  AgentBackend,
  AgentSessionRecord,
  PaneState,
  WorkspaceDirectoryOption,
  WorkspaceId,
  WorkspaceRecord,
} from "@muximo/domain";
import type { ClaimExecutionInput } from "./repositories.js";

/** Provider-neutral input for starting a managed agent session. */
export type StartAgentSessionInput = {
  backend: AgentBackend;
  name?: string;
  useWorktree: boolean;
  worktreeRoot?: string;
  setupHook?: string;
  cleanupHook?: string;
  setupHookExplicit: boolean;
  cleanupHookExplicit: boolean;
  backendArgs: readonly string[];
};

/** Provider-neutral input for resuming a managed agent session. */
export type ResumeAgentSessionInput = {
  workspaceScope: WorkspaceScope;
  reference: string;
  backendArgs: readonly string[];
};

/** Provider-neutral input for cleaning up a managed agent session. */
export type CleanupAgentSessionInput = {
  workspaceScope: WorkspaceScope;
  force: boolean;
  reference: string;
};

export type WorkspaceScope = "current" | "all";

export type AgentSessionListInput = {
  workspaceScope: WorkspaceScope;
  includeUnavailable: boolean;
};

export type AgentSessionWorktreeState = "not_applicable" | "available" | "missing" | "unregistered" | "unknown";

export type AgentSessionExecutionHealth = "inactive" | "active" | "long_running" | "stale" | "unknown";

export type AgentSessionResumeState = "available" | "unavailable" | "unknown";

export type AgentSessionResumeReason =
  | "backend_session_missing"
  | "backend_session_discovery_required"
  | "currently_running"
  | "execution_state_unknown"
  | "not_resumable_state"
  | "worktree_missing"
  | "worktree_state_unknown"
  | "worktree_unregistered";

export type AgentBackendResumeState = "available" | "missing" | "discovery_required";

export type AgentSessionListObservation = {
  now: number;
  processAlive?: boolean;
  worktreeState: AgentSessionWorktreeState;
  backendResumeState: AgentBackendResumeState;
};

export type AgentSessionListProjection = {
  session: AgentSessionRecord;
  executionHealth: AgentSessionExecutionHealth;
  resume: AgentSessionResumeState;
  resumeReason: AgentSessionResumeReason | null;
  worktreeState: AgentSessionWorktreeState;
  visibleByDefault: boolean;
};

export type AgentSessionListResult = {
  allViews: AgentSessionListProjection[];
  views: AgentSessionListProjection[];
};

export type ManagedWorktreeState = {
  worktreeRoot?: string;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
};

export type CleanupDisposition = "removed" | "retained" | "failed";

export type CleanupReason =
  | "cleanup_declined"
  | "remote_archive_failed"
  | "remote_restore_failed"
  | "cleanup_hook_failed"
  | "unregistered_worktree"
  | "worktree_removal_failed";

export type CleanupResult =
  | { disposition: "removed" }
  | { disposition: "retained"; reason: CleanupReason }
  | { disposition: "failed"; reason: CleanupReason };

export type ProcessResult = {
  code: number;
  interrupted: boolean;
  signal?: string | null;
};

/** Provider-neutral identity data that may be learned while launching a session. */
export type SessionIdentityUpdate = {
  backendSessionId?: string;
};

export type HookSessionUpdate = {
  setupOutputFile?: string;
  cleanupOutputFile?: string;
};

export type HookResult = {
  success: boolean;
  sessionUpdate?: HookSessionUpdate;
};

export type SessionBaselineResult = {
  success: boolean;
};

export type LaunchExecution = {
  process: ProcessResult;
  sessionUpdate?: SessionIdentityUpdate;
};

export type LaunchPlan = {
  run(): Promise<LaunchExecution>;
  dispose(): Promise<void>;
};

export type LaunchPreparation = {
  plan: LaunchPlan;
  sessionUpdate?: SessionIdentityUpdate;
};

export type RunAgentSessionResult = {
  process: ProcessResult;
  session: AgentSessionRecord;
  cleanup: CleanupResult | { disposition: "not_requested"; reason: "interrupted" | "no_worktree" };
};

export type ResumeAgentSessionResult = {
  process: ProcessResult;
  session: AgentSessionRecord;
};

export type CleanupAgentSessionResult = {
  session: AgentSessionRecord;
  cleanup: CleanupResult;
};

/** Resolves the workspace selected by the current runtime context. */
export interface WorkspaceResolverPort {
  resolveCurrent(): Promise<WorkspaceRecord>;
}

/** Generates collision-free names without inspecting provider arguments. */
export interface SessionNamingPort {
  resolveName(workspaceId: WorkspaceId, requestedName: string | undefined, backend: AgentBackend): Promise<string>;
}

/** Resolves and executes workspace hooks; it never mutates a session record. */
export interface HookPort {
  resolveHook(value: string, workspaceRoot: string): Promise<string>;
  resolveStoredHook(path: string | undefined): Promise<string | undefined>;
  run(session: AgentSessionRecord, kind: "setup" | "cleanup"): Promise<HookResult>;
  removeOutputs(session: AgentSessionRecord): Promise<void>;
}

/** Owns Git worktree creation, copy, inspection, and removal. */
export interface WorktreePort {
  create(workspace: WorkspaceDirectoryOption, name: string, override?: string): Promise<ManagedWorktreeState>;
  copyFiles(
    target: Pick<AgentSessionRecord, "workspaceRoot" | "worktreePath">,
    patterns: readonly string[],
  ): Promise<boolean>;
  isRegistered(session: AgentSessionRecord): Promise<boolean>;
  hasChanges(session: AgentSessionRecord): Promise<boolean>;
  remove(session: AgentSessionRecord, force: boolean): Promise<CleanupResult>;
}

/** Provider-neutral launch and baseline capability. */
export interface SessionLauncherPort {
  captureBaseline(session: AgentSessionRecord): Promise<SessionBaselineResult>;
  prepareLaunch(
    session: AgentSessionRecord,
    backendArgs: readonly string[],
    resume: boolean,
  ): Promise<LaunchPreparation>;
}

/** Provider-neutral remote-session lifecycle used by cleanup policy. */
export interface RemoteSessionPort {
  archive(session: AgentSessionRecord): Promise<boolean>;
  restore(session: AgentSessionRecord): Promise<boolean>;
}

/** Releases provider-owned resources after the session record is deleted. */
export interface SessionResourcePort {
  releaseIfUnused(session: AgentSessionRecord, remaining: readonly AgentSessionRecord[]): Promise<void>;
}

/** Provider state and output observed for a managed agent session. */
export type AgentStateObservation = {
  state: PaneState;
  recentOutput?: string;
};

/** Receives provider observations for the currently running agent session. */
export interface AgentObservationPort {
  observe(session: AgentSessionRecord, observation: AgentStateObservation): Promise<void>;
}

/** Publishes agent lifecycle state to the current pane/control transport. */
export interface PanePublicationPort {
  adopt(session: AgentSessionRecord): Promise<void>;
  release(session: AgentSessionRecord): Promise<void>;
  publish(session: AgentSessionRecord, state: "running" | "completed" | "failed" | "stopped"): Promise<void>;
}

export interface ProcessObservationPort {
  isAlive(pid: number): Promise<boolean>;
}

/** Concrete observations used by the application-owned session list policy. */
export type SessionObservationPort = {
  resolveWorkspace(): Promise<Pick<WorkspaceRecord, "id">>;
  observeSession(session: AgentSessionRecord, now: number): Promise<AgentSessionListObservation>;
};

export type SessionListClock = {
  now(): number;
};

export interface SessionAuditPort {
  record(eventType: string, entityId: string, payload: unknown): void | Promise<void>;
}

export type SessionClock = {
  now(): string;
  id(): string;
};

export type ManagedAgentSessionRepository = {
  findById(id: AgentSessionRecord["id"]): Promise<AgentSessionRecord | undefined>;
  findByName(workspaceId: WorkspaceId, name: string): Promise<AgentSessionRecord | undefined>;
  list(workspaceId?: WorkspaceId): Promise<AgentSessionRecord[]>;
  insert(record: AgentSessionRecord): Promise<void>;
  update(record: AgentSessionRecord): Promise<void>;
  claimExecution(input: ClaimExecutionInput): Promise<boolean>;
  delete(id: AgentSessionRecord["id"]): Promise<void>;
};

export type SessionLogger = {
  child(fields: Record<string, unknown>): SessionLogger;
  debug(event: string, fields?: Record<string, unknown>): void;
};

export type SessionCleanupConfirmationPort = {
  confirm(session: AgentSessionRecord, dirty: boolean): Promise<boolean>;
};
