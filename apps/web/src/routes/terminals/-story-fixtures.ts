import type { PaneSummary, TmuxSession, WorkspaceDirectory } from "@muximo/contract";
import type { TerminalEndpoint } from "./-connection-flow-viewmodel";

export const storyTerminal: TerminalEndpoint = {
  id: "macbook-air",
  name: "MacBook Air",
  host: "toru-macbook-air",
  tailnetIp: "100.112.247.15",
  state: "online",
  detail: "muximod 0.1 · macOS",
  lastSeen: "active now",
};

export const storyOfflineTerminal: TerminalEndpoint = {
  id: "studio-mini",
  name: "Studio mini",
  host: "studio-mini",
  tailnetIp: "100.112.247.21",
  state: "offline",
  detail: "muximod 0.1 · macOS",
  lastSeen: "last seen 12m ago",
};

export const storyTerminals: TerminalEndpoint[] = [storyTerminal, storyOfflineTerminal];

export const storySession: TmuxSession = {
  name: "muximo",
  paneCount: 3,
  waitingCount: 1,
  detail: "2 agents · 1 shell · waiting input",
};

export const storySessions: TmuxSession[] = [
  storySession,
  { name: "release", paneCount: 1, waitingCount: 0, detail: "1 shell · active now" },
];

export const storyWorkspaces: WorkspaceDirectory[] = [
  {
    id: "workspace-muximo",
    name: "muximo",
    directory: "~/work/muximo",
    isGit: true,
    setupScriptPath: "~/.config/muximo/setup",
    cleanupScriptPath: "~/.config/muximo/cleanup",
    worktreeCopyPatterns: [".env", ".env.local"],
  },
  {
    id: "workspace-scratch",
    name: "scratch",
    directory: "~/tmp/scratch",
    isGit: false,
    setupScriptPath: null,
    cleanupScriptPath: null,
    worktreeCopyPatterns: [],
  },
];

export const storyPanes: PaneSummary[] = [
  {
    id: "pane-review",
    tmuxPaneId: "%0",
    sessionName: "muximo",
    windowId: "@0",
    paneIndex: 0,
    kind: "agent",
    name: "Review the viewport lease",
    cwd: "~/work/muximo",
    workspaceId: "muximo",
    agentId: "codex",
    state: "waiting_input",
    title: "codex · review",
    recentOutput: "Task complete.\nContinue with the next task? ▌",
    lastSeenAt: "2026-08-10T06:55:00.000Z",
    windowName: "muximo",
    windowIndex: 0,
  },
  {
    id: "pane-build",
    tmuxPaneId: "%1",
    sessionName: "muximo",
    windowId: "@0",
    paneIndex: 1,
    kind: "agent",
    name: "Ship the iOS shell",
    cwd: "~/work/muximo",
    workspaceId: "muximo",
    agentId: "claude",
    state: "running",
    title: "claude · implementation",
    recentOutput: "Running provider checks…",
    lastSeenAt: "2026-08-10T06:57:00.000Z",
    windowName: "muximo",
    windowIndex: 0,
  },
  {
    id: "pane-shell",
    tmuxPaneId: "%2",
    sessionName: "muximo",
    windowId: "@1",
    paneIndex: 0,
    kind: "shell",
    name: "Local shell",
    cwd: "~/work/muximo",
    workspaceId: "muximo",
    agentId: null,
    state: "running",
    title: "zsh",
    recentOutput: "$ bun test\n✓ all packages passed",
    lastSeenAt: "2026-08-10T06:58:00.000Z",
    windowName: "shell",
    windowIndex: 1,
  },
  {
    id: "pane-approval",
    tmuxPaneId: "%3",
    sessionName: "muximo",
    windowId: "@2",
    paneIndex: 0,
    kind: "agent",
    name: "Apply the migration",
    cwd: "~/work/muximo",
    workspaceId: "muximo",
    agentId: "codex",
    state: "waiting_approval",
    title: "codex · approval",
    recentOutput: "Apply this migration? ▌",
    lastSeenAt: "2026-08-10T06:42:00.000Z",
    windowName: "migration",
    windowIndex: 2,
  },
];
