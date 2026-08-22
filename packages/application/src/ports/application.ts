import type { AgentBackend, PaneRecord, Patch, WorkspaceRecord } from "@muximo/domain";

export type MuximodHookEvent =
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
  cwd?: string;
  workspaceId?: string;
  agentId: AgentBackend | null;
  useWorktree: boolean;
  placement: MuximodPanePlacement;
  targetPaneId: string | null;
};

export type CreateSessionInput = {
  name: string;
  initialCwd: string;
};

export type MuximodWorkspaceDirectory = {
  id: string;
  name: string;
  directory: string;
  isGit: boolean;
  setupScriptPath: string | null;
  cleanupScriptPath: string | null;
  worktreeCopyPatterns: string[];
};

export type RegisterWorkspaceCommand = {
  directory: string;
  name?: string;
  setupScriptPath?: Patch<string>;
  cleanupScriptPath?: Patch<string>;
  worktreeCopyPatterns?: readonly string[];
};

export type UpdateWorkspaceCommand = {
  name?: string;
  setupScriptPath?: Patch<string>;
  cleanupScriptPath?: Patch<string>;
  worktreeCopyPatterns?: readonly string[];
  appendWorktreeCopyPatterns?: readonly string[];
  clearWorktreeCopyPatterns?: boolean;
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
};

export type MuximodPaneSummary = PaneRecord;

/**
 * Application use-case port consumed by HTTP, CLI, and future native
 * adapters. It contains no transport-runtime, tmux, SQLite, or filesystem types.
 */
export type MuximodApplication = {
  terminal: {
    get(): Promise<MuximodTerminalEndpoint>;
  };
  workspaces: {
    list(): Promise<MuximodWorkspaceDirectory[]>;
    browse(parentPath?: string): Promise<MuximodWorkspaceDirectory[]>;
    register(input: RegisterWorkspaceCommand): Promise<MuximodWorkspaceDirectory>;
    update(workspaceId: string, input: UpdateWorkspaceCommand): Promise<MuximodWorkspaceDirectory>;
    delete(workspaceId: string): Promise<void>;
    resolveDirectory(workspaceId: string): Promise<WorkspaceRecord>;
    resolveSelection(selection: { workspaceId: string; mode: "workspace" | "worktree" }): Promise<WorkspaceRecord>;
  };
  sessions: {
    list(): Promise<MuximodSessionSummary[]>;
    create(input: CreateSessionInput): Promise<MuximodSessionSummary>;
  };
  panes: {
    list(sessionName?: string): Promise<MuximodPaneSummary[]>;
    create(input: CreatePaneInput, workspace?: WorkspaceRecord): Promise<MuximodPaneSummary>;
  };
  hooks: {
    handleTmux(event: MuximodHookEvent, client: string): void;
  };
};
