import type { WorkspaceRecord } from "@muximo/domain";
import type {
  CreatePaneInput,
  CreateSessionInput,
  MuximodPaneSummary,
  MuximodSessionSummary,
  MuximodTerminalEndpoint,
  MuximodWorkspaceDirectory,
  RegisterWorkspaceCommand,
  UpdateWorkspaceCommand,
} from "../models/muximod.js";

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
