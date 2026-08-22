import type { AgentBackend, PaneRecord, Patch } from "@muximo/domain";

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
