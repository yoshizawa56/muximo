import type { AgentBackend, PaneRecord, Patch } from "@muximo/domain";
import type {
  AgentSessionListInput,
  AgentSessionListResult,
  CleanupAgentSessionInput,
  CleanupAgentSessionResult,
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
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApplicationError";
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

export type MuximodPaneSummary = PaneRecord;

export type MuximodAgentSessionApplication = {
  run(input: StartAgentSessionInput): Promise<RunAgentSessionResult>;
  resume(input: ResumeAgentSessionInput): Promise<ResumeAgentSessionResult>;
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
