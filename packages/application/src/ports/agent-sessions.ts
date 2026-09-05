import type { AgentBackend, AgentSession, PaneState } from "@muximo/domain";

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

/** Provider state and output observed for a managed agent session. */
export type AgentStateObservation = {
  state: PaneState;
  recentOutput?: string;
};

export type ProcessLiveness = "alive" | "dead" | "unknown";
export type CleanupAgentSessionResult = {
  session: AgentSession;
  cleanup: CleanupResult;
};
