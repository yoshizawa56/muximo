import type { AgentBackend, Pane, Patch } from "@muximo/domain";
import type {
  AgentSessionListInput,
  AgentSessionListResult,
  AttachAgentSessionInput,
  CleanupAgentSessionInput,
  CleanupAgentSessionResult,
  CompleteAgentSessionInput,
  PreparedAgentSession,
  ResumeAgentSessionInput,
  ResumeAgentSessionResult,
  RunAgentSessionResult,
  StartAgentSessionInput,
} from "./agent-sessions.js";

export type ApplicationClock = {
  now(): string;
};

export type TerminalHostHookEvent =
  | "client-attached"
  | "client-active"
  | "client-resized"
  | "client-focus-in"
  | "client-detached";

/** A transport-neutral failure that may be mapped by an adapter. */
export class ApplicationError extends Error {
  public readonly _tag = "ApplicationError" as const;

  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApplicationError";
  }
}

/**
 * Machine-readable reasons for failures without a wire code. These never
 * reach the public contract: boundary mapping renders them exactly like an
 * uncoded Error (generic unavailable response), so the wire stays identical
 * while internals can narrow on reason.
 */
export type ApplicationFailureReason =
  | "shell_command_executable_missing"
  | "managed_worktree_requires_git"
  | "worktree_file_copy_failed"
  | "setup_hook_failed"
  | "managed_shell_worktree_retained"
  | "cleanup_hook_failed"
  | "agent_execution_not_current"
  | "agent_session_not_awaiting_process"
  | "agent_session_already_attached"
  | "daemon_wait_timeout_negative"
  | "daemon_wait_timeout_negative"
  | "agent_execution_preparation_cancelled"
  | "invalid_session_reference"
  | "session_reference_requires_all_scope"
  | "ambiguous_session_name"
  | "session_not_found"
  | "invalid_agent_session_name"
  | "agent_session_being_recovered"
  | "agent_session_liveness_unverifiable"
  | "agent_session_already_resuming"
  | "resume_setup_failed"
  | "resume_backend_not_started"
  | "resume_execution_unattached"
  | "resume_already_running"
  | "resume_owned_by_cli"
  | "resume_owner_unverifiable"
  | "agent_session_not_found"
  | "agent_session_not_resuming"
  | "agent_execution_receipt_mismatch"
  | "agent_session_name_exists"
  | "backend_baseline_capture_failed"
  | "agent_session_being_prepared"
  | "agent_session_being_finalized"
  | "agent_execution_being_recovered"
  | "agent_session_not_running"
  | "worktree_not_registered"
  | "abandoned_release_failed"
  | "abandoned_cleanup_failed";

/** A tagged failure for application paths that previously failed with a bare Error. */
export class ApplicationFailure extends Error {
  public readonly _tag = "ApplicationFailure" as const;

  public constructor(
    public readonly reason: ApplicationFailureReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "ApplicationFailure";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

// --- Boundary vocabulary owned by the MuximodApplication port ---

export type MuximodPanePlacement = "window" | "right" | "bottom";

export type CreatePaneInput = {
  sessionName: string;
  kind: "agent" | "shell";
  name: string;
  workspaceId?: string;
  agentId: AgentBackend | null;
  useWorktree: boolean;
  placement: MuximodPanePlacement;
  targetPaneId: string | null;
};

export type CreateSessionInput = {
  name: string;
  workspaceId: string;
};

export type ManageSessionInput = {
  name: string;
};

export type ManageSessionResult = {
  name: string;
  changed: boolean;
};

export type MuximodWorkspaceDirectory = {
  id: string;
  name: string;
  directory: string;
  isGit: boolean;
  setupScriptPath: string | null;
  cleanupScriptPath: string | null;
};

export type RegisterWorkspaceCommand = {
  directory: string;
  name?: string;
  setupScriptPath?: Patch<string>;
  cleanupScriptPath?: Patch<string>;
};

export type UpdateWorkspaceCommand = {
  name?: string;
  setupScriptPath?: Patch<string>;
  cleanupScriptPath?: Patch<string>;
};

export type MuximodTerminalEndpoint = {
  id: string;
  name: string;
  host: string;
  tailnetIp: string;
  state: "online" | "offline";
  detail: string;
  lastSeen: string;
};

export type MuximodSessionSummary = {
  name: string;
  paneCount: number;
  waitingCount: number;
  detail: string;
  managed: boolean;
};

export type MuximodPaneSummary = Pane;

export type MuximodAgentSessionApplication = {
  prepareRun(input: StartAgentSessionInput, signal?: AbortSignal): Promise<PreparedAgentSession>;
  prepareResume(input: ResumeAgentSessionInput, signal?: AbortSignal): Promise<PreparedAgentSession>;
  attach(input: AttachAgentSessionInput): Promise<void>;
  completeRun(input: CompleteAgentSessionInput): Promise<RunAgentSessionResult>;
  completeResume(input: CompleteAgentSessionInput): Promise<ResumeAgentSessionResult>;
  cleanup(input: CleanupAgentSessionInput): Promise<CleanupAgentSessionResult>;
  list(input: AgentSessionListInput): Promise<AgentSessionListResult>;
};

/**
 * Application use-case port consumed by delivery adapters. It contains no
 * transport-runtime, provider, SQLite, or filesystem types.
 */
export type MuximodApplication = {
  agentSessions: MuximodAgentSessionApplication;
  terminal: {
    get(): Promise<MuximodTerminalEndpoint>;
  };
  workspaces: {
    list(): Promise<MuximodWorkspaceDirectory[]>;
    browse(parentPath?: string): Promise<MuximodWorkspaceDirectory[]>;
    register(input: RegisterWorkspaceCommand): Promise<MuximodWorkspaceDirectory>;
    update(workspaceId: string, input: UpdateWorkspaceCommand): Promise<MuximodWorkspaceDirectory>;
    delete(workspaceId: string): Promise<void>;
  };
  sessions: {
    list(): Promise<MuximodSessionSummary[]>;
    create(input: CreateSessionInput): Promise<MuximodSessionSummary>;
    manage(input: ManageSessionInput): Promise<ManageSessionResult>;
  };
  panes: {
    list(sessionName?: string): Promise<MuximodPaneSummary[]>;
    create(input: CreatePaneInput): Promise<MuximodPaneSummary>;
  };
  hooks: {
    handleTerminalHostHook(event: TerminalHostHookEvent, client: string): Promise<void>;
  };
};
