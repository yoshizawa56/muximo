import type {
  AgentBackend,
  AgentSession,
  PaneState,
  Workspace,
  WorkspaceDirectoryOption,
  WorkspaceId,
} from "@muximo/domain";
import type { ApplicationEffect } from "../effect.js";
import type { ClaimAbandonedExecutionInput, ClaimExecutionInput } from "./repositories.js";

/** Provider-neutral input for starting a managed agent session. */
export type StartAgentSessionInput = {
  backend: AgentBackend;
  name?: string;
  hostPaneId?: string;
  workspace?: string;
  cwd?: string;
  useWorktree: boolean;
  worktreeRoot?: string;
  setupHook?: string;
  cleanupHook?: string;
  setupHookExplicit: boolean;
  cleanupHookExplicit: boolean;
  backendArgs: readonly string[];
  executionOwnerPid?: number;
};

/** Provider-neutral input for resuming a managed agent session. */
export type ResumeAgentSessionInput = {
  workspaceScope: WorkspaceScope;
  reference: string;
  hostPaneId?: string;
  backendArgs: readonly string[];
  executionOwnerPid?: number;
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
  session: AgentSession;
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

export type WorkspaceResolutionInput = {
  workspace?: string;
  cwd?: string;
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
  started: boolean;
  code: number;
  interrupted: boolean;
  signal?: string | null;
  failureDiagnostic?: string;
};

/** Serializable provider launch data handed to the host process that owns the TTY. */
export type AgentExecutionSpec = {
  sessionId: string;
  executionId: string;
  sessionName: string;
  backend: AgentBackend;
  command: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
};

export type AgentExecutionResult = ProcessResult & {
  pid?: number;
};

export type PreparedAgentSession = {
  session: AgentSession;
  execution: AgentExecutionSpec;
};

export type AttachAgentSessionInput = {
  agentSessionId: string;
  executionId: string;
  executionPid: number;
  executionStartedAt: string;
  executionOwnerPid?: number;
  executionOwnerStartedAt?: string;
  hostPaneId?: string;
};

export type CompleteAgentSessionInput = {
  agentSessionId: string;
  executionId: string;
  hostPaneId?: string;
  process: AgentExecutionResult;
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

export type LaunchPreparation = {
  execution: AgentExecutionSpec;
  sessionUpdate?: SessionIdentityUpdate;
};

export type RunAgentSessionResult = {
  process: ProcessResult;
  session: AgentSession;
  cleanup: CleanupResult | { disposition: "not_requested"; reason: "interrupted" | "no_worktree" };
};

export type ResumeAgentSessionResult = {
  process: ProcessResult;
  session: AgentSession;
};

/** Durable result returned after a host-owned execution has been finalized. */
export type AgentExecutionReceipt =
  | {
      operation: "run";
      agentSessionId: string;
      executionId: string;
      process: AgentExecutionResult;
      session: AgentSession;
      cleanup: RunAgentSessionResult["cleanup"];
    }
  | {
      operation: "resume";
      agentSessionId: string;
      executionId: string;
      process: AgentExecutionResult;
      session: AgentSession;
    };

export type CleanupAgentSessionResult = {
  session: AgentSession;
  cleanup: CleanupResult;
};

/** Resolves the workspace selected by the current runtime context. */
export interface WorkspaceResolverPort {
  resolveCurrent(input?: WorkspaceResolutionInput): ApplicationEffect<Workspace>;
}

/** Generates collision-free names without inspecting provider arguments. */
export interface SessionNamingPort {
  resolveName(
    workspaceId: WorkspaceId,
    requestedName: string | undefined,
    backend: AgentBackend,
  ): ApplicationEffect<string>;
}

/** Resolves and executes workspace hooks; it never mutates a session record. */
export interface HookPort {
  resolveHook(value: string, workspaceRoot: string): ApplicationEffect<string>;
  resolveStoredHook(path: string | undefined): ApplicationEffect<string | undefined>;
  run(session: AgentSession, kind: "setup" | "cleanup"): ApplicationEffect<HookResult>;
  removeOutputs(session: AgentSession): ApplicationEffect<void>;
}

/** Owns Git worktree creation, copy, inspection, and removal. */
export interface WorktreePort {
  create(workspace: WorkspaceDirectoryOption, name: string, override?: string): ApplicationEffect<ManagedWorktreeState>;
  copyFiles(target: Pick<AgentSession, "workspaceRoot" | "worktreePath">): ApplicationEffect<boolean>;
  isRegistered(session: AgentSession): ApplicationEffect<boolean>;
  hasChanges(session: AgentSession): ApplicationEffect<boolean>;
  remove(session: AgentSession, force: boolean): ApplicationEffect<CleanupResult>;
}

/** Provider-neutral launch and baseline capability. */
export interface SessionLauncherPort {
  captureBaseline(session: AgentSession): ApplicationEffect<SessionBaselineResult>;
  prepareLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    signal?: AbortSignal,
  ): ApplicationEffect<LaunchPreparation>;
  startLaunch(session: AgentSession): ApplicationEffect<void>;
  completeLaunch(
    session: AgentSession,
    process: AgentExecutionResult,
  ): ApplicationEffect<SessionIdentityUpdate | undefined>;
  disposeLaunch(session: AgentSession): ApplicationEffect<void>;
}

/** Provider-neutral remote-session lifecycle used by cleanup policy. */
export interface RemoteSessionPort {
  archive(session: AgentSession): ApplicationEffect<boolean>;
  restore(session: AgentSession): ApplicationEffect<boolean>;
}

/** Releases provider-owned resources after the session record is deleted. */
export interface SessionResourcePort {
  releaseIfUnused(session: AgentSession, remaining: readonly AgentSession[]): ApplicationEffect<void>;
}

/** Provider state and output observed for a managed agent session. */
export type AgentStateObservation = {
  state: PaneState;
  recentOutput?: string;
};

/** Receives provider observations for the currently running agent session. */
export interface AgentObservationPort {
  observe(session: AgentSession, observation: AgentStateObservation): ApplicationEffect<void>;
}

/** Publishes agent lifecycle state to the current pane/control transport. */
export interface PanePublicationPort {
  adopt(session: AgentSession, hostPaneId?: string): ApplicationEffect<void>;
  release(session: AgentSession, hostPaneId?: string): ApplicationEffect<void>;
  publish(
    session: AgentSession,
    state: "running" | "completed" | "failed" | "stopped",
    hostPaneId?: string,
  ): ApplicationEffect<void>;
}

export type ProcessLiveness = "alive" | "dead" | "unknown";

export interface ProcessObservationPort {
  observe(pid: number, expectedStartedAt?: string): ApplicationEffect<ProcessLiveness>;
}

/** Concrete observations used by the application-owned session list policy. */
export type SessionObservationPort = {
  resolveWorkspace(): ApplicationEffect<Pick<Workspace, "id">>;
  observeSession(session: AgentSession, now: number): ApplicationEffect<AgentSessionListObservation>;
};

export type SessionListClock = {
  now(): number;
};

export interface SessionAuditPort {
  record(eventType: string, entityId: string, payload: unknown): ApplicationEffect<void>;
}

export type SessionClock = {
  now(): string;
  id(): string;
};

export type ManagedAgentSessionRepository = {
  findById(id: AgentSession["id"]): ApplicationEffect<AgentSession | undefined>;
  findByName(workspaceId: WorkspaceId, name: string): ApplicationEffect<AgentSession | undefined>;
  list(workspaceId?: WorkspaceId): ApplicationEffect<AgentSession[]>;
  insert(record: AgentSession): ApplicationEffect<void>;
  update(record: AgentSession): ApplicationEffect<void>;
  claimExecution(input: ClaimExecutionInput): ApplicationEffect<boolean>;
  claimAbandonedExecution(input: ClaimAbandonedExecutionInput): ApplicationEffect<boolean>;
  attachExecution(input: import("./repositories.js").AttachExecutionInput): ApplicationEffect<boolean>;
  delete(id: AgentSession["id"]): ApplicationEffect<void>;
  findExecutionReceipt(executionId: string): ApplicationEffect<AgentExecutionReceipt | undefined>;
  saveExecutionReceipt(receipt: AgentExecutionReceipt): ApplicationEffect<void>;
};

export type SessionLogger = {
  child(fields: Record<string, unknown>): SessionLogger;
  debug(event: string, fields?: Record<string, unknown>): void;
};

export type SessionCleanupConfirmationPort = {
  confirm(session: AgentSession, dirty: boolean): ApplicationEffect<boolean>;
};
