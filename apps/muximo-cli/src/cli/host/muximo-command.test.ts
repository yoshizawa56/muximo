import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, it, expect } from "vitest";
import { TmuxAdapter } from "@muximo/infrastructure";
import {
  hasError,
  hasNoError,
  hasObserved,
  noFixture,
  returns,
  runOperationTable,
  runScenarioTable,
  type Assertion,
  type CleanupRegistrar,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import {
  AgentSession,
  AgentSessionId,
  clearPatch,
  Workspace,
  WorkspaceId,
  type AgentSessionRecord,
} from "@muximo/domain";
import { createLogger, type LogRecord } from "@muximo/infrastructure";
import { createAgentDatabase, DrizzleAgentSessionRepository, DrizzleWorkspaceRepository } from "@muximo/infrastructure";
import { MuximoCommand, buildResumeCommand, buildRunCommand } from "./muximo-command.js";

type EmptyContext = {};
type BuildInput = { kind: "run" | "resume"; backend: "codex" | "claude"; codexProfile?: string | null };
const buildCases = [
  { name: "leaves the Codex profile unselected by default", input: { kind: "run", backend: "codex" }, assert: [returns<EmptyContext, string[]>(["codex", "--remote", "unix://", "--cd", "/workspace"])] },
  { name: "preserves an explicitly selected Codex profile", input: { kind: "run", backend: "codex", codexProfile: "review" }, assert: [returns<EmptyContext, string[]>(["codex", "--profile", "review", "--remote", "unix://", "--cd", "/workspace"])] },
  { name: "injects Claude lifecycle flags", input: { kind: "run", backend: "claude" }, assert: [returns<EmptyContext, string[]>(["claude", "--name", "review", "--session-id", "claude-session", "--permission-mode", "auto"])] },
  { name: "places Codex resume before backend arguments without a default profile", input: { kind: "resume", backend: "codex" }, assert: [returns<EmptyContext, string[]>(["codex", "--remote", "unix://", "--cd", "/workspace", "resume", "codex-session", "--", "inspect"])] },
] satisfies readonly OperationCase<"default", BuildInput, string[], EmptyContext>[];

const buildTable: OperationTable<undefined, "default", BuildInput, string[], EmptyContext> = {
  defaultFixture: noFixture(),
  cases: buildCases,
  execute: (_fixture, input) => {
    const session = sessionFixture(input.backend, input.codexProfile ?? null);
    return input.kind === "run" ? buildRunCommand(session, [], "unix://", input.backend) : buildResumeCommand(session, ["--", "inspect"], "unix://", input.backend);
  },
  observe: () => ({}),
};

type AgentFixtureKey = "worktree" | "interrupt" | "remote" | "missing" | "diagnostic" | "cleanup-missing" | "legacy" | "multiple" | "competing";
type AgentStep = { [Key in AgentFixtureKey]: { type: Key } }[AgentFixtureKey];
type AgentResult = { codes: Record<string, number> };
type AgentContext = {
  codes: Record<string, number>;
  output: string;
  finalOutput: string;
  resumeOutput: string;
  log: string;
  remoteLog: string;
  nameLog: string;
  worktreeList: string;
  worktreeRoot: string;
  stateEntries: readonly string[];
  elapsedMs: number;
  backendSessionId: string | null;
};
type AgentFixture = {
  root: string;
  workspace: string;
  setupHook: string;
  cleanupHook: string;
  worktree: string;
  worktreeRoot: string;
  state: string;
  log: string;
  database: string;
  env: NodeJS.ProcessEnv;
  output: string;
  finalOutput: string;
  resumeOutput: string;
  codes: Record<string, number>;
  remoteLog?: string;
  nameLog?: string;
  sessionName?: string;
  backendSessionIdOverride?: string | null;
  elapsedMs: number;
};

const containsText = <K extends keyof AgentContext>(key: K, text: string): Assertion<AgentContext, AgentResult> => ({
  name: `contains ${text} in ${String(key)}`,
  check: (ctx) => expect(String(ctx[key])).toContain(text),
});
const excludesText = <K extends keyof AgentContext>(key: K, text: string): Assertion<AgentContext, AgentResult> => ({
  name: `does not contain ${text} in ${String(key)}`,
  check: (ctx) => expect(String(ctx[key])).not.toContain(text),
});
const lessThan = <K extends keyof AgentContext>(key: K, limit: number): Assertion<AgentContext, AgentResult> => ({
  name: `${String(key)} is less than ${limit}`,
  check: (ctx) => expect(ctx[key]).toBeLessThan(limit),
});

const agentCases = [
  {
    name: "runs registered workspace hooks, creates a worktree, and cleans it up through SQLite state",
    fixture: "worktree",
    steps: [{ type: "worktree" }],
    assert: [
      hasNoError<AgentContext, AgentResult>(),
      hasObserved<AgentContext, AgentResult>("codes", { run: 0 }),
      containsText("log", "setup cwd="),
      containsText("log", "setup env=secret-from-workspace nested=local-config"),
      {
        name: "runs the backend inside the managed worktree",
        check: (ctx: AgentContext) => expect(ctx.log).toContain(`backend cwd=${ctx.worktreeRoot}/session`),
      },
      containsText("log", "cleanup cwd="),
      excludesText("worktreeList", "/session"),
      hasObserved<AgentContext, AgentResult>("stateEntries", []),
      containsText("output", "session 'session' cleaned up"),
    ],
  },
  {
    name: "keeps interrupted sessions resumable and deletes them explicitly",
    fixture: "interrupt",
    steps: [{ type: "interrupt" }],
    assert: [hasNoError<AgentContext, AgentResult>(), hasObserved<AgentContext, AgentResult>("codes", { first: 130, resume: 0, cleanup: 0, list: 0 }), hasObserved<AgentContext, AgentResult>("finalOutput", "")],
  },
  {
    name: "preserves Codex managed remote naming and archive lifecycle",
    fixture: "remote",
    steps: [{ type: "remote" }],
    assert: [hasNoError<AgentContext, AgentResult>(), containsText("remoteLog", "[app-server] [daemon] [enable-remote-control]"), containsText("remoteLog", "[resume] [codex-session-id]"), containsText("nameLog", "[--name] [remote]"), containsText("nameLog", "[--archive]"), containsText("resumeOutput", "recovered Codex session ID for 'remote'"), hasObserved<AgentContext, AgentResult>("backendSessionId", "codex-session-id")],
  },
  {
    name: "does not wait for a missing remote rollout before finishing",
    fixture: "missing",
    steps: [{ type: "missing" }],
    assert: [hasNoError<AgentContext, AgentResult>(), hasObserved<AgentContext, AgentResult>("codes", { run: 0 }), lessThan("elapsedMs", 2_000), containsText("output", "rollout scan:"), containsText("output", "files=0"), containsText("output", "root=missing")],
  },
  {
    name: "reports privacy-safe reasons for rejected Codex rollouts",
    fixture: "diagnostic",
    steps: [{ type: "diagnostic" }],
    assert: [hasError<AgentContext, AgentResult>({ message: /no backend session ID/ }), containsText("output", "invalid_json=1"), containsText("output", "not_session_meta=1"), containsText("output", "missing_session_id=1"), containsText("output", "cwd_mismatch=1"), containsText("output", "unsupported_originator=1"), containsText("output", "subagent=1"), containsText("output", "baseline=1"), excludesText("output", "baseline-session")],
  },
  {
    name: "does not archive a Codex thread when cleanup has no safe ID mapping",
    fixture: "cleanup-missing",
    steps: [{ type: "cleanup-missing" }],
    assert: [hasNoError<AgentContext, AgentResult>(), hasObserved<AgentContext, AgentResult>("codes", { cleanup: 1 }), containsText("output", "cannot archive Codex remote thread; session ID is missing"), containsText("output", "session 'cleanup' retained because cleanup did not complete"), hasObserved<AgentContext, AgentResult>("backendSessionId", null)],
  },
  {
    name: "captures legacy flat Codex session metadata",
    fixture: "legacy",
    steps: [{ type: "legacy" }],
    assert: [hasNoError<AgentContext, AgentResult>(), hasObserved<AgentContext, AgentResult>("codes", { run: 0 }), hasObserved<AgentContext, AgentResult>("backendSessionId", "legacy-codex-session")],
  },
  {
    name: "does not guess when multiple Codex rollouts match a missing mapping",
    fixture: "multiple",
    steps: [{ type: "multiple" }],
    assert: [hasError<AgentContext, AgentResult>({ message: /no backend session ID/ }), containsText("output", "cannot safely recover Codex session ID for 'first'"), hasObserved<AgentContext, AgentResult>("backendSessionId", null)],
  },
  {
    name: "does not bind a rollout while another unbound Codex session uses the same directory",
    fixture: "competing",
    steps: [{ type: "competing" }],
    assert: [hasError<AgentContext, AgentResult>({ message: /no backend session ID/ }), containsText("output", "competing_session=1"), hasObserved<AgentContext, AgentResult>("backendSessionId", null)],
  },
] satisfies readonly ScenarioCase<AgentFixtureKey, AgentStep, AgentResult, AgentContext>[];

const fixtureFactories: Readonly<Record<AgentFixtureKey, () => Promise<FixtureHandle<AgentFixture>>>> = {
  worktree: async () => {
    const fixture = createFixture();
    await addWorkspaceRecord(fixture);
    return toHandle(fixture);
  },
  interrupt: async () => toHandle(createFixture({ TEST_AGENT_EXIT_STATUS: "130" })),
  remote: async () => {
    const fixture = createFixture({ TEST_AGENT_SESSION_ID: "codex-session-id" });
    const fakeCodex = join(fixture.root, "fake-codex");
    const fakeName = join(fixture.root, "fake-codex-name");
    fixture.nameLog = join(fixture.root, "name.log");
    fixture.remoteLog = join(fixture.root, "remote.log");
    writeExecutable(fakeCodex, `#!/bin/sh\nprintf 'codex:' >>"$TEST_AGENT_REMOTE_LOG"\nfor arg in "$@"; do printf ' [%s]' "$arg" >>"$TEST_AGENT_REMOTE_LOG"; done\nprintf '\\n' >>"$TEST_AGENT_REMOTE_LOG"\nif [ "\${1:-}" = "app-server" ]; then exit 0; fi\nmkdir -p "$CODEX_HOME/sessions/test"\nprintf '{"timestamp":"2026-08-14T00:00:00.000Z","type":"session_meta","payload":{"id":"%s","session_id":"%s","cwd":"%s","originator":"codex_chatgpt_ios_remote","thread_source":"user"}}\\n' "$TEST_AGENT_SESSION_ID" "$TEST_AGENT_SESSION_ID" "$PWD" >"$CODEX_HOME/sessions/test/$TEST_AGENT_SESSION_ID.jsonl"\n`);
    writeExecutable(fakeName, `#!/bin/sh\ncase " $* " in\n  *" --archive "*) label=archive ;;\n  *" --unarchive "*) label=unarchive ;;\n  *) label=name ;;\nesac\nprintf '%s:' "$label" >>"$TEST_AGENT_NAME_LOG"\nfor arg in "$@"; do printf ' [%s]' "$arg" >>"$TEST_AGENT_NAME_LOG"; done\nprintf '\\n' >>"$TEST_AGENT_NAME_LOG"\n`);
    fixture.env = { ...fixture.env, MUXIMO_CODEX_BIN: fakeCodex, MUXIMO_CODEX_NAME_BIN: fakeName, CODEX_HOME: join(fixture.root, "codex-home"), TEST_AGENT_NAME_LOG: fixture.nameLog, TEST_AGENT_REMOTE_LOG: fixture.remoteLog };
    return toHandle(fixture);
  },
  missing: async () => {
    const fixture = createFixture();
    const fakeCodex = join(fixture.root, "fake-codex-no-rollout");
    writeExecutable(fakeCodex, `#!/bin/sh\nif [ "\${1:-}" = "app-server" ]; then exit 0; fi\nexit 0\n`);
    fixture.env = { ...fixture.env, MUXIMO_CODEX_BIN: fakeCodex, CODEX_HOME: join(fixture.root, "codex-home") };
    return toHandle(fixture);
  },
  diagnostic: async () => {
    const fixture = createFixture({ MUXIMO_CODEX_REMOTE: "" });
    await addDiagnosticRollouts(fixture);
    return toHandle(fixture);
  },
  "cleanup-missing": async () => {
    const fixture = createFixture({ MUXIMO_CODEX_REMOTE: "" });
    await addCleanupRollout(fixture);
    return toHandle(fixture);
  },
  legacy: async () => {
    const fixture = createFixture({ MUXIMO_CODEX_REMOTE: "", TEST_AGENT_SESSION_ID: "legacy-codex-session" });
    const fakeCodex = join(fixture.root, "fake-codex");
    writeExecutable(fakeCodex, `#!/bin/sh\nmkdir -p "$CODEX_HOME/sessions/test"\nprintf '{"type":"session_meta","id":"%s","session_id":"%s","cwd":"%s","originator":"codex_cli_rs","thread_source":"user"}\\n' "$TEST_AGENT_SESSION_ID" "$TEST_AGENT_SESSION_ID" "$PWD" >"$CODEX_HOME/sessions/test/$TEST_AGENT_SESSION_ID.jsonl"\n`);
    fixture.env = { ...fixture.env, MUXIMO_CODEX_BIN: fakeCodex, CODEX_HOME: join(fixture.root, "codex-home") };
    return toHandle(fixture);
  },
  multiple: async () => {
    const fixture = createFixture({ MUXIMO_CODEX_REMOTE: "" });
    await addMultipleRollouts(fixture);
    return toHandle(fixture);
  },
  competing: async () => {
    const fixture = createFixture({ MUXIMO_CODEX_REMOTE: "" });
    await addCompetingRollout(fixture);
    return toHandle(fixture);
  },
};

const agentTable: ScenarioTable<AgentFixture, AgentFixtureKey, AgentStep, AgentResult, AgentContext> = {
  defaultFixture: fixtureFactories.worktree,
  fixtures: fixtureFactories,
  cases: agentCases,
  execute: async (fixture, steps) => {
    if (steps.length !== 1) throw new Error("muximo command scenario requires exactly one action step");
    const step = steps[0]!;
    switch (step.type) {
      case "worktree": return executeWorktree(fixture);
      case "interrupt": return executeInterrupt(fixture);
      case "remote": return executeRemote(fixture);
      case "missing": return executeMissing(fixture);
      case "diagnostic": return executeDiagnostic(fixture);
      case "cleanup-missing": return executeCleanupMissing(fixture);
      case "legacy": return executeLegacy(fixture);
      case "multiple": return executeMultiple(fixture);
      case "competing": return executeCompeting(fixture);
      default: return assertNever(step);
    }
  },
  observe: async (fixture) => ({
    codes: { ...fixture.codes },
    output: fixture.output,
    finalOutput: fixture.finalOutput,
    resumeOutput: fixture.resumeOutput,
    log: safeRead(fixture.log),
    remoteLog: safeRead(fixture.remoteLog),
    nameLog: safeRead(fixture.nameLog),
    worktreeList: safeExec(["git", "-C", fixture.workspace, "worktree", "list", "--porcelain"]),
    worktreeRoot: fixture.worktreeRoot,
    stateEntries: safeReadDirectory(fixture.state),
    elapsedMs: fixture.elapsedMs,
    backendSessionId: fixture.backendSessionIdOverride ?? (fixture.sessionName ? await readBackendSessionId(fixture) : null),
  }),
};

type ExtendedFixtureKey = "managed-session" | "shell-context" | "worktree-shell" | "shell-worktree" | "unmanaged-pane" | "rollback" | "log-level" | "diagnostics";
type ExtendedStep = { [Key in ExtendedFixtureKey]: { type: Key } }[ExtendedFixtureKey];
type ExtendedResult = { code: number };
type ExtendedFixture = AgentFixture & {
  tmux: RecordingTmuxAdapter;
  outputStream: Writable & { value: () => string };
  records: LogRecord[];
  shellWorktree?: string;
  logger?: ReturnType<typeof createLogger>;
};
type ExtendedContext = {
  output: string;
  log: string;
  workspace: string;
  worktree: string;
  shellWorktree: string;
  remainingWorktrees: readonly string[];
  created?: { name: string; cwd: string; command?: string };
  options: readonly { name: string; key: string; value: string }[];
  environments: readonly { name: string; key: string; value: string }[];
  sessionMetadata: readonly { name: string; field: "managed_session_id" | "managed" | "wrapper"; value: string }[];
  paneMetadata: readonly { paneId: string; field: string; value: string }[];
  killed: readonly string[];
  records: readonly LogRecord[];
};

const managedSessionAssertion: Assertion<ExtendedContext, ExtendedResult> = {
  name: "configures the managed session wrapper",
  check: (ctx) => {
    expect(ctx.created).toMatchObject({ name: "work", cwd: ctx.workspace });
    expect(ctx.created?.command).toContain("'/opt/muximo/muximo' shell");
    expect(ctx.options).toEqual([{ name: "work", key: "default-command", value: "'/opt/muximo/muximo' shell" }]);
    expect(ctx.environments).toEqual([
      { name: "work", key: "MUXIMOD_MANAGED_SESSION_ID", value: expect.any(String) },
      { name: "work", key: "MUXIMOD_MANAGED_SESSION_NAME", value: "work" },
    ]);
    expect(ctx.sessionMetadata).toEqual([
      { name: "work", field: "managed_session_id", value: expect.any(String) },
      { name: "work", field: "managed", value: "1" },
      { name: "work", field: "wrapper", value: "muximo-shell" },
    ]);
    expect(ctx.output).toMatch(/created managed tmux session 'work' \([0-9a-f-]+\)/);
  },
};

const shellContextAssertion: Assertion<ExtendedContext, ExtendedResult> = {
  name: "passes and restores the wrapped shell metadata without a run identity",
  check: (ctx) => {
    expect(ctx.log).toMatch(/wrapped=1 managed=work/);
    expect(ctx.paneMetadata.filter((entry) => entry.field === "kind").map((entry) => entry.value)).toEqual(["shell", "shell"]);
    expect(ctx.paneMetadata.some((entry) => entry.field === "managed_session_id" && entry.value === "managed-session")).toBe(true);
    expect(ctx.paneMetadata.some((entry) => entry.field === "pane_name" && entry.value === "terminal-shell")).toBe(true);
  },
};

const unmanagedPaneAssertion: Assertion<ExtendedContext, ExtendedResult> = {
  name: "restores unmanaged pane metadata after the agent exits",
  check: (ctx) => {
    expect(ctx.paneMetadata.filter((entry) => entry.field === "kind").map((entry) => entry.value)).toEqual(["agent", "shell"]);
    expect(ctx.paneMetadata.filter((entry) => entry.field === "agent_id").map((entry) => entry.value)).toEqual(["claude", ""]);
    expect(ctx.paneMetadata.some((entry) => entry.field === "run_id")).toBe(false);
  },
};

const rollbackAssertion: Assertion<ExtendedContext, ExtendedResult> = {
  name: "kills a partially configured session",
  check: (ctx) => expect(ctx.killed).toEqual(["broken"]),
};

const diagnosticsAssertion: Assertion<ExtendedContext, ExtendedResult> = {
  name: "records privacy-safe lifecycle diagnostics",
  check: (ctx) => {
    const events = ctx.records.map((record) => record.event);
    expect(events).toEqual(expect.arrayContaining(["command.started", "database.opened", "session.created", "subprocess.started", "subprocess.finished", "session.finished"]));
    expect(JSON.stringify(ctx.records)).not.toContain("sensitive prompt");
    expect(ctx.records.find((record) => record.event === "subprocess.finished")).toMatchObject({ fields: { kind: "backend", exitCode: 0 } });
  },
};

const extendedCases = [
  { name: "creates a managed tmux session with an agent shell default", fixture: "managed-session", steps: [{ type: "managed-session" }], assert: [returns<ExtendedContext, ExtendedResult>({ code: 0 }), managedSessionAssertion] },
  { name: "passes the wrapped shell context to a child agent command", fixture: "shell-context", steps: [{ type: "shell-context" }], assert: [returns<ExtendedContext, ExtendedResult>({ code: 0 }), shellContextAssertion] },
  {
    name: "starts the shell after a worktree agent in that worktree",
    fixture: "worktree-shell",
    steps: [{ type: "worktree-shell" }],
    assert: [
      returns<ExtendedContext, ExtendedResult>({ code: 0 }),
      {
        name: "uses the AgentSession worktree as the interactive shell cwd",
        check: (ctx: ExtendedContext) => expect(ctx.log).toContain(`shell cwd=${ctx.shellWorktree} session=`),
      },
    ],
  },
  {
    name: "creates and cleans up a self-contained shell worktree with hooks",
    fixture: "shell-worktree",
    steps: [{ type: "shell-worktree" }],
    assert: [
      returns<ExtendedContext, ExtendedResult>({ code: 0 }),
      {
        name: "runs the setup hook inside the worktree after copying unmanaged files",
        check: (ctx: ExtendedContext) => expect(ctx.log).toContain(`setup cwd=${join(ctx.worktree, "review")} worktree=${join(ctx.worktree, "review")} workspace=${ctx.workspace}`),
      },
      {
        name: "runs the cleanup hook with the worktree as cwd",
        check: (ctx: ExtendedContext) => expect(ctx.log).toContain(`cleanup cwd=${join(ctx.worktree, "review")}`),
      },
      {
        name: "starts the interactive shell inside the worktree",
        check: (ctx: ExtendedContext) => expect(ctx.log).toContain(`shell cwd=${join(ctx.worktree, "review")}`),
      },
      {
        name: "copies unmanaged files and removes the worktree afterwards",
        check: (ctx: ExtendedContext) => {
          expect(ctx.log).toContain("setup env=secret-from-workspace nested=local-config");
          expect(ctx.remainingWorktrees).toEqual([]);
        },
      },
    ],
  },
  { name: "returns an unmanaged pane to shell metadata after the agent exits", fixture: "unmanaged-pane", steps: [{ type: "unmanaged-pane" }], assert: [returns<ExtendedContext, ExtendedResult>({ code: 0 }), unmanagedPaneAssertion] },
  { name: "rolls back a partially configured managed tmux session", fixture: "rollback", steps: [{ type: "rollback" }], assert: [hasError<ExtendedContext, ExtendedResult>({ message: /simulated tmux option failure/ }), rollbackAssertion] },
  { name: "keeps daemon log-level configuration out of attached CLI verbosity", fixture: "log-level", steps: [{ type: "log-level" }], assert: [returns<ExtendedContext, ExtendedResult>({ code: 0 }), { name: "does not emit command diagnostics", check: (ctx: ExtendedContext) => expect(ctx.output).not.toContain("command.started") }] },
  { name: "emits detailed lifecycle diagnostics without logging backend arguments", fixture: "diagnostics", steps: [{ type: "diagnostics" }], assert: [returns<ExtendedContext, ExtendedResult>({ code: 0 }), diagnosticsAssertion] },
] satisfies readonly ScenarioCase<ExtendedFixtureKey, ExtendedStep, ExtendedResult, ExtendedContext>[];

const extendedFixtureFactories: Readonly<Record<ExtendedFixtureKey, () => Promise<FixtureHandle<ExtendedFixture>>>> = {
  "managed-session": async () => {
    const fixture = createExtendedFixture();
    fixture.env = { ...fixture.env, MUXIMOD_MUXIMO_COMMAND: "/opt/muximo/muximo" };
    return toExtendedHandle(fixture);
  },
  "shell-context": async () => {
    const fixture = createExtendedFixture();
    const child = join(fixture.root, "child-command");
    writeExecutable(child, "#!/bin/sh\nprintf 'wrapped=%s managed=%s\\n' \"$MUXIMOD_WRAPPED_SHELL\" \"$MUXIMOD_MANAGED_SESSION_NAME\" >>\"$TEST_AGENT_LOG\"\n");
    fixture.env = { ...fixture.env, TMUX_PANE: "%7", MUXIMOD_MANAGED_SESSION_ID: "managed-session", MUXIMOD_MANAGED_SESSION_NAME: "work", MUXIMOD_PANE_NAME: "terminal-shell" };
    return toExtendedHandle(fixture);
  },
  "worktree-shell": async () => {
    const fixture = createExtendedFixture();
    const child = join(fixture.root, "child-command");
    const shell = join(fixture.root, "worktree-shell");
    const worktreePath = join(fixture.worktree, "review");
    mkdirSync(worktreePath, { recursive: true });
    fixture.shellWorktree = realpathSync(worktreePath);
    writeExecutable(child, "#!/bin/sh\nexit 0\n");
    writeExecutable(shell, "#!/bin/sh\nprintf 'shell cwd=%s session=%s\\n' \"$PWD\" \"${MUXIMOD_WORKTREE_SESSION_NAME:-}\" >>\"$TEST_AGENT_LOG\"\nexit 0\n");
    await insertSession(fixture, AgentSession.create({
      ...sessionFixture("claude"),
      id: AgentSessionId.create("worktree-session-id"),
      name: "review",
      workspaceId: workspaceIdFor(fixture),
      workspaceRoot: realpathSync(fixture.workspace),
      workspaceName: "workspace",
      worktreeRoot: fixture.worktreeRoot,
      worktreePath: fixture.shellWorktree,
      branch: "muximo/review",
      useWorktree: true,
    }));
    fixture.env = { ...fixture.env, MUXIMOD_WORKTREE_SESSION_NAME: "review" };
    fixture.env.MUXIMO_CLAUDE_BIN = child;
    fixture.env.MUXIMOD_SHELL_BIN = shell;
    return toExtendedHandle(fixture);
  },
  "shell-worktree": async () => {
    const fixture = createExtendedFixture();
    const shell = join(fixture.root, "worktree-shell");
    writeExecutable(shell, "#!/bin/sh\nprintf 'shell cwd=%s\\n' \"$PWD\" >>\"$TEST_AGENT_LOG\"\nexit 0\n");
    fixture.env = { ...fixture.env, MUXIMOD_SHELL_BIN: shell };
    return toExtendedHandle(fixture);
  },
  "unmanaged-pane": async () => {
    const fixture = createExtendedFixture();
    fixture.env = { ...fixture.env, TMUX_PANE: "%7" };
    return toExtendedHandle(fixture);
  },
  rollback: async () => toExtendedHandle(createExtendedFixture({ failOnSessionOption: true })),
  "log-level": async () => {
    const fixture = createExtendedFixture();
    fixture.env = { ...fixture.env, MUXIMO_LOG_LEVEL: "debug" };
    return toExtendedHandle(fixture);
  },
  diagnostics: async () => {
    const fixture = createExtendedFixture();
    fixture.logger = createLogger({
      service: "muximo-cli",
      mode: "attached",
      level: "debug",
      sink: { write: (record) => fixture.records.push(record) },
    });
    return toExtendedHandle(fixture);
  },
};

const extendedTable: ScenarioTable<ExtendedFixture, ExtendedFixtureKey, ExtendedStep, ExtendedResult, ExtendedContext> = {
  defaultFixture: extendedFixtureFactories["managed-session"],
  fixtures: extendedFixtureFactories,
  cases: extendedCases,
  execute: async (fixture, steps) => {
    if (steps.length !== 1) throw new Error("extended muximo command scenario requires exactly one action step");
    const step = steps[0]!;
    switch (step.type) {
      case "managed-session":
        return { code: await runExtendedCommand(fixture, ["tmux", "new-session", "-s", "work", "-c", fixture.workspace, "--detached"]) };
      case "shell-context": {
        const child = join(fixture.root, "child-command");
        return { code: await runExtendedCommand(fixture, ["shell", "--exit-after-command", "--", child]) };
      }
      case "worktree-shell": {
        const child = join(fixture.root, "child-command");
        const shell = join(fixture.root, "worktree-shell");
        return { code: await runExtendedCommand(fixture, ["shell", "--shell", shell, "--", child]) };
      }
      case "shell-worktree": {
        const shell = join(fixture.root, "worktree-shell");
        const registered = await runExtendedCommand(fixture, [
          "workspace", "add", ".",
          "--setup-hook", fixture.setupHook,
          "--cleanup-hook", fixture.cleanupHook,
          "--copy-pattern", ".env",
          "--copy-pattern", "config/*.local.json",
        ]);
        if (registered !== 0) return { code: registered };
        return { code: await runExtendedCommand(fixture, ["shell", "--shell", shell, "--worktree", "review"]) };
      }
      case "unmanaged-pane":
        return { code: await runExtendedCommand(fixture, ["run", "claude", "--no-worktree", "-n", "unmanaged"]) };
      case "rollback":
        return { code: await runExtendedCommand(fixture, ["tmux", "new-session", "-s", "broken", "--detached"]) };
      case "log-level":
        return { code: await runExtendedCommand(fixture, ["help"]) };
      case "diagnostics":
        return { code: await runExtendedCommand(fixture, ["run", "claude", "--no-worktree", "--", "--prompt", "sensitive prompt"]) };
      default:
        return assertNever(step);
    }
  },
  observe: (fixture) => ({
    output: fixture.outputStream.value(),
    log: safeRead(fixture.log),
    workspace: realpathSync(fixture.workspace),
    worktree: fixture.worktreeRoot,
    shellWorktree: fixture.shellWorktree ?? "",
    remainingWorktrees: safeExec(["git", "-C", fixture.workspace, "worktree", "list", "--porcelain"]).split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length)).filter((path) => path !== realpathSync(fixture.workspace)),
    created: fixture.tmux.created,
    options: [...fixture.tmux.options],
    environments: [...fixture.tmux.environments],
    sessionMetadata: [...fixture.tmux.sessionMetadata],
    paneMetadata: [...fixture.tmux.paneMetadata],
    killed: [...fixture.tmux.killed],
    records: [...fixture.records],
  }),
};

type NamingFixtureKey = "worktree-name" | "lookup-exact" | "lookup-qualified" | "collision";
type NamingInput =
  | { kind: "worktree"; requestedName: string }
  | { kind: "cleanup"; reference: string }
  | { kind: "run"; requestedName: string };
type NamingResult = number;
type NamingFixture = AgentFixture & { sessionNames: readonly string[]; worktreeRoot: string };
type NamingContext = {
  log: string;
  output: string;
  remaining: readonly string[];
  worktreeRoot: string;
};

const namingCases = [
  {
    name: "uses the normalized name for the worktree and session",
    fixture: "worktree-name",
    input: { kind: "worktree", requestedName: "API review" },
    assert: [
      returns<NamingContext, NamingResult>(0),
      {
        name: "creates the canonical worktree",
        check: (ctx: NamingContext) => {
          expect(ctx.log).toContain(`backend cwd=${ctx.worktreeRoot}/api-review`);
          expect(ctx.output).toContain("session 'api-review' cleaned up");
        },
      },
    ],
  },
  {
    name: "uses an exact legacy name before normalized lookup",
    fixture: "lookup-exact",
    input: { kind: "cleanup", reference: "Review" },
    assert: [returns<NamingContext, NamingResult>(0), hasObserved<NamingContext, NamingResult>("remaining", ["review"])],
  },
  {
    name: "rejects a workspace-qualified reference without global mode",
    fixture: "lookup-qualified",
    input: { kind: "cleanup", reference: "other/bar" },
    assert: [
      hasError<NamingContext, NamingResult>({ message: /workspace-qualified session references require --global/ }),
      hasObserved<NamingContext, NamingResult>("remaining", ["bar"]),
    ],
  },
  {
    name: "rejects a new canonical name that collides with a legacy name",
    fixture: "collision",
    input: { kind: "run", requestedName: "review" },
    assert: [
      hasError<NamingContext, NamingResult>({ message: /session name already exists/ }),
      hasObserved<NamingContext, NamingResult>("remaining", ["Review"]),
    ],
  },
] satisfies readonly OperationCase<NamingFixtureKey, NamingInput, NamingResult, NamingContext>[];

const namingFixtureFactories: Readonly<Record<NamingFixtureKey, (registerCleanup?: CleanupRegistrar) => Promise<FixtureHandle<NamingFixture>>>> = {
  "worktree-name": async (registerCleanup) => {
    const fixture = createNamingFixture([]);
    return toHandle(fixture, registerCleanup);
  },
  "lookup-exact": async (registerCleanup) => {
    const fixture = createNamingFixture(["Review", "review"]);
    const handle = toHandle(fixture, registerCleanup);
    await seedSessionRecords(fixture, fixture.sessionNames);
    return handle;
  },
  "lookup-qualified": async (registerCleanup) => {
    const fixture = createNamingFixture(["bar"]);
    const handle = toHandle(fixture, registerCleanup);
    await seedSessionRecords(fixture, fixture.sessionNames);
    return handle;
  },
  collision: async (registerCleanup) => {
    const fixture = createNamingFixture(["Review"]);
    const handle = toHandle(fixture, registerCleanup);
    await seedSessionRecords(fixture, fixture.sessionNames);
    return handle;
  },
};

const namingTable: OperationTable<NamingFixture, NamingFixtureKey, NamingInput, NamingResult, NamingContext> = {
  defaultFixture: namingFixtureFactories["worktree-name"],
  fixtures: namingFixtureFactories,
  cases: namingCases,
  execute: async (fixture, input) => {
    const args = input.kind === "worktree"
      ? ["run", "claude", "--worktree", input.requestedName]
      : input.kind === "cleanup"
        ? ["cleanup", "--force", input.reference]
        : ["run", "claude", "--no-worktree", "--name", input.requestedName];
    const result = await runCommand(fixture, args);
    fixture.output = result.output;
    fixture.codes = { naming: result.code ?? -1 };
    if (result.error) throw result.error;
    return result.code ?? -1;
  },
  observe: async (fixture) => ({
    log: safeRead(fixture.log),
    output: fixture.output,
    remaining: fixture.sessionNames.length === 0 ? [] : await storedSessionNames(fixture, workspaceIdFor(fixture)),
    worktreeRoot: fixture.worktreeRoot,
  }),
};

function createNamingFixture(sessionNames: readonly string[]): NamingFixture {
  const fixture = createFixture();
  return { ...fixture, sessionNames, worktreeRoot: realpathSync(fixture.worktree) };
}

function createExtendedFixture(options: { failOnSessionOption?: boolean } = {}): ExtendedFixture {
  return { ...createFixture(), tmux: new RecordingTmuxAdapter(options), outputStream: captureOutput(), records: [] };
}

function toExtendedHandle(fixture: ExtendedFixture): FixtureHandle<ExtendedFixture> {
  return { fixture, cleanup: () => { fixture.logger?.close(); rmSync(fixture.root, { recursive: true, force: true }); } };
}

async function runExtendedCommand(fixture: ExtendedFixture, args: string[]): Promise<number> {
  const command = new MuximoCommand({
    cwd: fixture.workspace,
    databaseFile: fixture.database,
    env: fixture.env,
    io: { out: fixture.outputStream, err: fixture.outputStream },
    logger: fixture.logger,
    tmux: fixture.tmux,
  });
  try {
    return await command.execute(args);
  } finally {
    command.close();
  }
}
function assertNever(value: never): never {
  throw new Error(`unhandled muximo command step: ${String(value)}`);
}

describe("muximo command migration", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, buildTable);
  runScenarioTable(register, agentTable);
  runScenarioTable(register, extendedTable);
  runOperationTable(register, namingTable);
});

async function executeWorktree(fixture: AgentFixture): Promise<AgentResult> {
  const result = await runCommand(fixture, ["run", "claude", "--worktree", "session"]);
  fixture.output = result.output;
  fixture.codes = { run: result.code ?? -1 };
  if (result.error) throw result.error;
  return { codes: fixture.codes };
}

async function executeInterrupt(fixture: AgentFixture): Promise<AgentResult> {
  const first = await runCommand(fixture, ["run", "claude", "--no-worktree", "-n", "interrupted"]);
  const resume = await runCommand(fixture, ["resume", "interrupted"], { ...fixture.env, TEST_AGENT_EXIT_STATUS: "0" });
  const cleanup = await runCommand(fixture, ["cleanup", "interrupted"], { ...fixture.env, TEST_AGENT_EXIT_STATUS: "0" });
  const list = await runCommand(fixture, ["list", "--json"], { ...fixture.env, MUXIMO_ASSUME_YES: "1", TEST_AGENT_EXIT_STATUS: "0" });
  fixture.codes = { first: first.code ?? -1, resume: resume.code ?? -1, cleanup: cleanup.code ?? -1, list: list.code ?? -1 };
  fixture.finalOutput = list.output;
  fixture.output = `${first.output}${resume.output}${cleanup.output}`;
  if (first.error || resume.error || cleanup.error || list.error) throw first.error ?? resume.error ?? cleanup.error ?? list.error;
  return { codes: fixture.codes };
}

async function executeRemote(fixture: AgentFixture): Promise<AgentResult> {
  const first = await runCommand(fixture, ["run", "codex", "--no-worktree", "-n", "remote"]);
  const database = createAgentDatabase(fixture.database);
  const sessions = new DrizzleAgentSessionRepository(database.db);
  const workspaceId = workspaceIdFor(fixture);
  const stored = await sessions.findByName(workspaceId, "remote");
  if (!stored) throw new Error("test session was not persisted");
  await sessions.update(AgentSession.update(stored, { backendSessionId: clearPatch }));
  database.close();
  const resumed = await runCommand(fixture, ["resume", "remote"]);
  fixture.resumeOutput = resumed.output;
  const repairedDatabase = createAgentDatabase(fixture.database);
  const repaired = await new DrizzleAgentSessionRepository(repairedDatabase.db).findByName(workspaceId, "remote");
  fixture.sessionName = "remote";
  fixture.backendSessionIdOverride = repaired?.backendSessionId ?? null;
  fixture.codes = { run: first.code ?? -1, resume: resumed.code ?? -1 };
  fixture.output = first.output;
  fixture.env = { ...fixture.env, MUXIMO_ASSUME_YES: "1" };
  const cleanup = await runCommand(fixture, ["cleanup", "remote"]);
  fixture.codes.cleanup = cleanup.code ?? -1;
  fixture.output += cleanup.output;
  fixture.env = { ...fixture.env, TEST_REPAIRED_SESSION_ID: repaired?.backendSessionId ?? "" };
  repairedDatabase.close();
  if (first.error || resumed.error || cleanup.error) throw first.error ?? resumed.error ?? cleanup.error;
  return { codes: fixture.codes };
}

async function executeMissing(fixture: AgentFixture): Promise<AgentResult> {
  const startedAt = Date.now();
  const result = await runCommand(fixture, ["run", "codex", "--no-worktree", "-n", "missing"]);
  fixture.elapsedMs = Date.now() - startedAt;
  fixture.output = result.output;
  fixture.codes = { run: result.code ?? -1 };
  if (result.error) throw result.error;
  return { codes: fixture.codes };
}

async function executeDiagnostic(fixture: AgentFixture): Promise<AgentResult> {
  const result = await runCommand(fixture, ["resume", "diagnostic"]);
  fixture.output = result.output;
  if (result.error) throw result.error;
  fixture.codes = { resume: result.code ?? -1 };
  return { codes: fixture.codes };
}

async function executeCleanupMissing(fixture: AgentFixture): Promise<AgentResult> {
  const result = await runCommand(fixture, ["cleanup", "cleanup"]);
  fixture.output = result.output;
  fixture.codes = { cleanup: result.code ?? -1 };
  fixture.sessionName = "cleanup";
  if (result.error) throw result.error;
  return { codes: fixture.codes };
}

async function executeLegacy(fixture: AgentFixture): Promise<AgentResult> {
  const result = await runCommand(fixture, ["run", "codex", "--no-worktree", "-n", "legacy"]);
  fixture.output = result.output;
  fixture.codes = { run: result.code ?? -1 };
  fixture.sessionName = "legacy";
  if (result.error) throw result.error;
  return { codes: fixture.codes };
}

async function executeMultiple(fixture: AgentFixture): Promise<AgentResult> {
  const result = await runCommand(fixture, ["resume", "first"]);
  fixture.output = result.output;
  fixture.sessionName = "first";
  if (result.error) throw result.error;
  fixture.codes = { resume: result.code ?? -1 };
  return { codes: fixture.codes };
}

async function executeCompeting(fixture: AgentFixture): Promise<AgentResult> {
  const result = await runCommand(fixture, ["resume", "target"]);
  fixture.output = result.output;
  fixture.sessionName = "target";
  if (result.error) throw result.error;
  fixture.codes = { resume: result.code ?? -1 };
  return { codes: fixture.codes };
}

async function runCommand(fixture: AgentFixture, args: string[], environment = fixture.env): Promise<{ code?: number; output: string; error?: unknown }> {
  const output = captureOutput();
  const command = new MuximoCommand({ cwd: fixture.workspace, databaseFile: fixture.database, env: environment, io: { out: output, err: output } });
  try {
    return { code: await command.execute(args), output: output.value() };
  } catch (error) {
    return { error, output: output.value() };
  } finally {
    command.close();
  }
}

async function addWorkspaceRecord(fixture: AgentFixture): Promise<void> {
  const database = createAgentDatabase(fixture.database);
  await new DrizzleWorkspaceRepository(database.db).upsert(Workspace.create({ id: workspaceIdFor(fixture), rootPath: realpathSync(fixture.workspace), name: "workspace", isGit: true, setupScriptPath: fixture.setupHook, cleanupScriptPath: fixture.cleanupHook, worktreeCopyPatterns: [".env", "config/**/*.local.json"], createdAt: "2026-08-10T00:00:00.000Z", updatedAt: "2026-08-10T00:00:00.000Z" }));
  database.close();
}

async function addDiagnosticRollouts(fixture: AgentFixture): Promise<void> {
  const codexHome = join(fixture.root, "codex-home");
  const sessionRoot = join(codexHome, "sessions", "diagnostic");
  mkdirSync(sessionRoot, { recursive: true });
  fixture.env = { ...fixture.env, CODEX_HOME: codexHome };
  const workspaceRoot = realpathSync(fixture.workspace);
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  await insertSession(fixture, AgentSession.create({ ...sessionFixture("codex"), id: AgentSessionId.create("diagnostic-id"), name: "diagnostic", workspaceId: workspaceIdFor(fixture), workspaceRoot, workspaceName: "workspace", backendSessionId: undefined, codexRemote: undefined, codexSessionBaseline: JSON.stringify({ codexSessions: ["baseline-session"] }), createdAt, updatedAt: new Date(Date.now() + 5_000).toISOString() }));
  writeFileSync(join(sessionRoot, "invalid.jsonl"), "not-json\n");
  writeFileSync(join(sessionRoot, "event.jsonl"), `${JSON.stringify({ type: "event" })}\n`);
  writeFileSync(join(sessionRoot, "missing-id.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { cwd: workspaceRoot, originator: "codex-tui", thread_source: "user" } })}\n`);
  writeFileSync(join(sessionRoot, "wrong-cwd.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "wrong-cwd", session_id: "wrong-cwd", cwd: "/other", originator: "codex-tui", thread_source: "user" } })}\n`);
  writeFileSync(join(sessionRoot, "originator.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "originator", session_id: "originator", cwd: workspaceRoot, originator: "codex-cli", thread_source: "user" } })}\n`);
  writeFileSync(join(sessionRoot, "subagent.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "subagent", session_id: "subagent", cwd: workspaceRoot, originator: "codex-tui", thread_source: "subagent" } })}\n`);
  writeFileSync(join(sessionRoot, "baseline.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "baseline-session", session_id: "baseline-session", cwd: workspaceRoot, originator: "codex-tui", thread_source: "user" } })}\n`);
}

async function addCleanupRollout(fixture: AgentFixture): Promise<void> {
  const codexHome = join(fixture.root, "codex-home");
  const sessionRoot = join(codexHome, "sessions", "cleanup");
  mkdirSync(sessionRoot, { recursive: true });
  fixture.env = { ...fixture.env, CODEX_HOME: codexHome };
  const workspaceRoot = realpathSync(fixture.workspace);
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  await insertSession(fixture, AgentSession.create({ ...sessionFixture("codex"), id: AgentSessionId.create("cleanup-id"), name: "cleanup", workspaceId: workspaceIdFor(fixture), workspaceRoot, workspaceName: "workspace", backendSessionId: undefined, codexRemote: "unix://", codexSessionBaseline: JSON.stringify({ codexSessions: [] }), createdAt, updatedAt: new Date(Date.now() + 5_000).toISOString() }));
  writeFileSync(join(sessionRoot, "rollout.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "cleanup-session", session_id: "cleanup-session", cwd: workspaceRoot, originator: "codex-tui", thread_source: "user" } })}\n`);
}

async function addMultipleRollouts(fixture: AgentFixture): Promise<void> {
  const codexHome = join(fixture.root, "codex-home");
  const sessionRoot = join(codexHome, "sessions", "test");
  mkdirSync(sessionRoot, { recursive: true });
  fixture.env = { ...fixture.env, CODEX_HOME: codexHome };
  const workspaceRoot = realpathSync(fixture.workspace);
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  const database = createAgentDatabase(fixture.database);
  const sessions = new DrizzleAgentSessionRepository(database.db);
  for (const name of ["first", "second"]) {
    await sessions.insert(AgentSession.create({ ...sessionFixture("codex"), id: AgentSessionId.create(`${name}-id`), name, workspaceId: workspaceIdFor(fixture), workspaceRoot, workspaceName: "workspace", useWorktree: false, worktreeRoot: undefined, worktreePath: undefined, branch: undefined, baseCommit: undefined, setupHook: undefined, cleanupHook: undefined, setupOutputFile: undefined, cleanupOutputFile: undefined, backendSessionId: undefined, codexRemote: undefined, codexSessionBaseline: JSON.stringify({ codexSessions: [] }), createdAt, updatedAt: new Date(Date.now() + 5_000).toISOString() }));
    writeFileSync(join(sessionRoot, `${name}.jsonl`), `${JSON.stringify({ type: "session_meta", payload: { id: `${name}-id`, session_id: `${name}-id`, cwd: workspaceRoot, originator: "codex_chatgpt_ios_remote", thread_source: "user" } })}\n`);
  }
  database.close();
}

async function addCompetingRollout(fixture: AgentFixture): Promise<void> {
  const codexHome = join(fixture.root, "codex-home");
  const sessionRoot = join(codexHome, "sessions", "test");
  mkdirSync(sessionRoot, { recursive: true });
  fixture.env = { ...fixture.env, CODEX_HOME: codexHome };
  const workspaceRoot = realpathSync(fixture.workspace);
  const createdAt = new Date(Date.now() - 60_000).toISOString();
  await insertSession(fixture, AgentSession.create({ ...sessionFixture("codex"), id: AgentSessionId.create("target-id"), name: "target", workspaceId: workspaceIdFor(fixture), workspaceRoot, workspaceName: "workspace", backendSessionId: undefined, codexRemote: undefined, codexSessionBaseline: JSON.stringify({ codexSessions: [] }), createdAt, updatedAt: new Date(Date.now() + 5_000).toISOString() }));
  await insertSession(fixture, AgentSession.create({ ...sessionFixture("codex"), id: AgentSessionId.create("competing-id"), name: "competing", workspaceId: workspaceIdFor(fixture), workspaceRoot, workspaceName: "workspace", backendSessionId: undefined, codexRemote: undefined, codexSessionBaseline: JSON.stringify({ codexSessions: [] }), createdAt, updatedAt: new Date(Date.now() + 5_000).toISOString() }));
  writeFileSync(join(sessionRoot, "rollout.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "competing-session", session_id: "competing-session", cwd: workspaceRoot, originator: "codex-tui", thread_source: "user" } })}\n`);
}

async function insertSession(fixture: AgentFixture, record: AgentSessionRecord): Promise<void> {
  const database = createAgentDatabase(fixture.database);
  await new DrizzleAgentSessionRepository(database.db).insert(record);
  database.close();
}

async function seedSessionRecords(fixture: AgentFixture, names: readonly string[]): Promise<string> {
  const workspaceId = workspaceIdFor(fixture);
  const database = createAgentDatabase(fixture.database);
  const sessions = new DrizzleAgentSessionRepository(database.db);
  for (const [index, name] of names.entries()) {
    await sessions.insert(AgentSession.validate({
      ...sessionFixture("claude"),
      id: AgentSessionId.create(`legacy-session-${index}`),
      name,
      workspaceId,
      workspaceRoot: realpathSync(fixture.workspace),
      workspaceName: "workspace",
    }));
  }
  database.close();
  return workspaceId;
}

async function storedSessionNames(fixture: AgentFixture, workspaceId: WorkspaceId): Promise<string[]> {
  const database = createAgentDatabase(fixture.database);
  const sessions = await new DrizzleAgentSessionRepository(database.db).list(workspaceId);
  database.close();
  return sessions.map((session) => session.name);
}

async function readBackendSessionId(fixture: AgentFixture): Promise<string | null> {
  const database = createAgentDatabase(fixture.database);
  const value = await new DrizzleAgentSessionRepository(database.db).findByName(workspaceIdFor(fixture), fixture.sessionName!);
  database.close();
  return value?.backendSessionId ?? null;
}

function workspaceIdFor(fixture: AgentFixture): WorkspaceId { return WorkspaceId.create(createHash("sha256").update(realpathSync(fixture.workspace)).digest("hex").slice(0, 16)); }

function createFixture(extraEnv: Record<string, string> = {}): AgentFixture {
  const root = mkdtempSync(join(tmpdir(), "muximo-cli-test-"));
  const workspace = join(root, "workspace");
  const worktree = join(root, "worktrees");
  const state = join(root, "state");
  const log = join(root, "hooks.log");
  const database = join(root, "muximod.sqlite");
  const fakeClaude = join(root, "fake-claude");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(worktree, { recursive: true });
  const hooks = join(root, "hooks");
  mkdirSync(hooks, { recursive: true });
  writeExecutable(fakeClaude, `#!/bin/sh\nprintf 'backend cwd=%s\\n' "$PWD" >>"$TEST_AGENT_LOG"\nexit "\${TEST_AGENT_EXIT_STATUS:-0}"\n`);
  const setupHook = join(hooks, "setup");
  const cleanupHook = join(hooks, "cleanup");
  writeExecutable(setupHook, `#!/bin/sh\nprintf 'setup cwd=%s worktree=%s workspace=%s\\n' "$PWD" "$MUXIMO_WORKTREE" "$MUXIMO_WORKSPACE" >>"$TEST_AGENT_LOG"\nprintf 'setup env=%s nested=%s\\n' "$(cat .env 2>/dev/null || printf missing)" "$(cat config/local.local.json 2>/dev/null || printf missing)" >>"$TEST_AGENT_LOG"\nprintf 'resource-id=test-resource\\n'\n`);
  writeExecutable(cleanupHook, `#!/bin/sh\nprintf 'cleanup cwd=%s setup-output=%s\\n' "$PWD" "$MUXIMO_SETUP_OUTPUT_FILE" >>"$TEST_AGENT_LOG"\n`);
  writeFileSync(join(workspace, "README"), "fixture\n");
  writeFileSync(join(workspace, ".gitignore"), ".env\nconfig/*.local.json\n");
  writeFileSync(join(workspace, ".env"), "secret-from-workspace\n");
  mkdirSync(join(workspace, "config"), { recursive: true });
  writeFileSync(join(workspace, "config", "local.local.json"), "local-config\n");
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "agent@example.invalid"]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Agent Test"]);
  execFileSync("git", ["-C", workspace, "add", "README", ".gitignore"]);
  execFileSync("git", ["-C", workspace, "commit", "-q", "-m", "fixture"]);
  return { root, workspace, setupHook, cleanupHook, worktree, worktreeRoot: realpathSync(worktree), state, log, database, env: { ...process.env, MUXIMOD_DB_FILE: database, MUXIMO_HOOK_OUTPUT_DIR: state, MUXIMO_WORKTREE_ROOT: worktree, MUXIMO_CLAUDE_BIN: fakeClaude, MUXIMO_ASSUME_YES: "1", TEST_AGENT_LOG: log, ...extraEnv }, output: "", finalOutput: "", resumeOutput: "", codes: {}, elapsedMs: 0 };
}

function toHandle<Fixture extends AgentFixture>(fixture: Fixture, registerCleanup?: CleanupRegistrar): FixtureHandle<Fixture> {
  const cleanup = () => rmSync(fixture.root, { recursive: true, force: true });
  if (registerCleanup) {
    registerCleanup(cleanup);
    return { fixture };
  }
  return { fixture, cleanup };
}
function writeExecutable(path: string, content: string): void { writeFileSync(path, content, { mode: 0o700 }); chmodSync(path, 0o700); }
function safeRead(path: string | undefined): string { if (!path) return ""; try { return readFileSync(path, "utf8"); } catch { return ""; } }
function safeReadDirectory(path: string): string[] { try { return readdirSync(path); } catch { return []; } }
function safeExec(args: string[]): string { try { return execFileSync(args[0]!, args.slice(1), { encoding: "utf8" }); } catch { return ""; } }
class RecordingTmuxAdapter extends TmuxAdapter {
  public created?: { name: string; cwd: string; command?: string };
  public options: Array<{ name: string; key: string; value: string }> = [];
  public environments: Array<{ name: string; key: string; value: string }> = [];
  public sessionMetadata: Array<{ name: string; field: "managed_session_id" | "managed" | "wrapper"; value: string }> = [];
  public paneMetadata: Array<{ paneId: string; field: string; value: string }> = [];
  public killed: string[] = [];
  private readonly failOnSessionOption: boolean;

  public constructor(options: { failOnSessionOption?: boolean } = {}) {
    super("/private/tmp/muximo-cli-test.sock");
    this.failOnSessionOption = options.failOnSessionOption ?? false;
  }

  public override hasSession(): boolean { return false; }
  public override createSession(name: string, cwd: string, command?: string): void { this.created = { name, cwd, command }; }
  public override setSessionOption(name: string, key: string, value: string): void {
    if (this.failOnSessionOption) throw new Error("simulated tmux option failure");
    this.options.push({ name, key, value });
  }
  public override killSession(name: string): void { this.killed.push(name); }
  public override setSessionEnvironment(name: string, key: string, value: string): void { this.environments.push({ name, key, value }); }
  public override setManagedSessionMetadata(name: string, field: "managed_session_id" | "managed" | "wrapper", value: string): void { this.sessionMetadata.push({ name, field, value }); }
  public override setAgentPaneMetadata(paneId: string, field: "pane_id" | "pane_name" | "kind" | "agent_id" | "workspace_id" | "managed_session_id", value: string): void { this.paneMetadata.push({ paneId, field, value }); }
  public override attachSession(): number { return 0; }
}
function captureOutput(): Writable & { value: () => string } { let value = ""; const output = new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } }) as Writable & { value: () => string }; output.value = () => value; return output; }

function sessionFixture(backend: "codex" | "claude", codexProfile: string | null = null): AgentSessionRecord {
  return AgentSession.create({
    id: AgentSessionId.create("session-id"),
    name: "review",
    backend,
    status: "running",
    workspaceId: WorkspaceId.create("workspace-id"),
    workspaceRoot: "/workspace",
    workspaceName: "workspace",
    useWorktree: false,
    backendSessionId: backend === "codex" ? "codex-session" : "claude-session",
    ...(backend === "codex" && codexProfile !== null ? { codexProfile } : {}),
    ...(backend === "codex" ? { codexRemote: "unix://" } : {}),
    setupRan: false,
    resuming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
}
