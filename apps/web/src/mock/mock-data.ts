import type { PaneSummary } from "@muximo/contract";

export const mockPanes: PaneSummary[] = [
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
    lastSeenAt: "2026-08-10T06:55:00.000Z",
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
    lastSeenAt: "2026-08-10T06:57:00.000Z",
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
    lastSeenAt: "2026-08-10T06:58:00.000Z",
  },
  {
    id: "pane-approval",
    tmuxPaneId: "%3",
    sessionName: "papercal",
    windowId: "@2",
    paneIndex: 0,
    kind: "agent",
    name: "Check the migration plan",
    cwd: "~/work/papercal",
    workspaceId: "papercal",
    agentId: "codex",
    state: "waiting_approval",
    title: "codex · approval",
    lastSeenAt: "2026-08-10T06:42:00.000Z",
  },
];

export const mockTerminalOutput = [
  "\x1b[1;38;5;111m muximo \x1b[0m  \x1b[38;5;244m/ review viewport\x1b[0m",
  "",
  "\x1b[38;5;151m╭─ agent status ─────────────────────╮\x1b[0m",
  "\x1b[38;5;151m│\x1b[0m \x1b[1;38;5;223mwaiting for input\x1b[0m  \x1b[38;5;244mrun-review\x1b[0m \x1b[38;5;151m│\x1b[0m",
  "\x1b[38;5;151m│\x1b[0m lease: \x1b[38;5;120mmobile\x1b[0m  pane: \x1b[38;5;244m%0\x1b[0m              \x1b[38;5;151m│\x1b[0m",
  "\x1b[38;5;151m╰────────────────────────────────────╯\x1b[0m",
  "",
  "\x1b[1;38;5;117m$\x1b[0m git diff --stat",
  " muximo-cli/muximo-command.ts | 612 +++++",
  " web/styles.css             | 248 +++++",
  " persistence/schema.ts      |  72 +++",
  " 3 files changed, 932 insertions(+)",
  "",
  "\x1b[1;38;5;117m$\x1b[0m bun test",
  "\x1b[38;5;151m✓\x1b[0m 15 packages passed  \x1b[38;5;244m1.42s\x1b[0m",
  "",
  "\x1b[1;38;5;223m?\x1b[0m Continue with the next task? \x1b[1;38;5;223m▌\x1b[0m",
].join("\r\n");

export const mockShellTerminalOutput = [
  "\x1b[1;38;5;120m~/work/muximo\x1b[0m \x1b[38;5;244m(main)\x1b[0m",
  "\x1b[1;38;5;82m❯\x1b[0m git status --short",
  "\x1b[38;5;151m M apps/web/src/styles.css\x1b[0m",
  "\x1b[38;5;151m M apps/web/src/mock/mock-data.ts\x1b[0m",
  "",
  "\x1b[1;38;5;82m❯\x1b[0m bun run --filter @muximo/web test",
  "\x1b[38;5;120m✓\x1b[0m 1 test file passed  \x1b[38;5;244m0.18s\x1b[0m",
  "",
  "\x1b[1;38;5;120m~/work/muximo\x1b[0m \x1b[1;38;5;82m❯\x1b[0m \x1b[?25l▌\x1b[?25h",
].join("\r\n");

export const mockRunningAgentTerminalOutput = [
  "\x1b[1;38;5;111m muximo \x1b[0m  \x1b[38;5;244m/ iOS shell\x1b[0m",
  "",
  "\x1b[38;5;151m╭─ agent status ─────────────────────╮\x1b[0m",
  "\x1b[38;5;151m│\x1b[0m \x1b[1;38;5;120mrunning\x1b[0m  \x1b[38;5;244mrun-build\x1b[0m                 \x1b[38;5;151m│\x1b[0m",
  "\x1b[38;5;151m│\x1b[0m lease: \x1b[38;5;120mmobile\x1b[0m  pane: \x1b[38;5;244m%1\x1b[0m              \x1b[38;5;151m│\x1b[0m",
  "\x1b[38;5;151m╰────────────────────────────────────╯\x1b[0m",
  "",
  "\x1b[1;38;5;117m$\x1b[0m bun test",
  "\x1b[38;5;151m⠋\x1b[0m running checks…",
].join("\r\n");

export const mockApprovalTerminalOutput = [
  "\x1b[1;38;5;111m papercal \x1b[0m  \x1b[38;5;244m/ migration plan\x1b[0m",
  "",
  "\x1b[38;5;151m╭─ agent status ─────────────────────╮\x1b[0m",
  "\x1b[38;5;151m│\x1b[0m \x1b[1;38;5;223mwaiting for approval\x1b[0m  \x1b[38;5;244mrun-migration\x1b[0m  \x1b[38;5;151m│\x1b[0m",
  "\x1b[38;5;151m│\x1b[0m lease: \x1b[38;5;120mmobile\x1b[0m  pane: \x1b[38;5;244m%3\x1b[0m              \x1b[38;5;151m│\x1b[0m",
  "\x1b[38;5;151m╰────────────────────────────────────╯\x1b[0m",
  "",
  "\x1b[1;38;5;117m$\x1b[0m git diff --stat",
  " papercal/migrations/2026-08.sql | 42 +++++",
  "",
  "\x1b[1;38;5;223m?\x1b[0m Apply this migration? \x1b[1;38;5;223m▌\x1b[0m",
].join("\r\n");

export function mockTerminalOutputForTarget(target: string): string {
  if (target === "%4") return mockShellTerminalOutput;
  const pane = mockPanes.find((candidate) => candidate.tmuxPaneId === target);
  if (pane?.kind === "shell") return mockShellTerminalOutput;
  if (pane?.state === "waiting_approval") return mockApprovalTerminalOutput;
  if (pane?.state === "running") return mockRunningAgentTerminalOutput;
  return mockTerminalOutput;
}

export function isMockMode(): boolean {
  const configured = import.meta.env.VITE_MUXIMOD_MOCK_MODE as string | undefined;
  return configured === "true" || (configured === undefined && import.meta.env.STORYBOOK === "true");
}
