import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { workspaceIdForPath } from "@muximo/infrastructure";
import {
  hasError,
  hasNoError,
  hasObserved,
  runOperationTable,
  returns,
  type CleanupRegistrar,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { AgentSession, AgentSessionId, Workspace, WorkspaceId, type AgentSessionRecord } from "@muximo/domain";
import { createAgentDatabase, DrizzleAgentSessionRepository, DrizzleWorkspaceRepository } from "@muximo/infrastructure";
import { MuximoCommand } from "./muximo-command.js";

type ListFixture = {
  root: string;
  workspace: string;
  database: string;
  output: Writable & { value: () => string };
};

type ListInput = {
  all: boolean;
};

type ListResult = {
  code: number;
};

type ListContext = {
  output: string;
  records: readonly Record<string, unknown>[];
};

const listCases = [
  {
    name: "hides an old exited session after its worktree disappears",
    input: { all: false },
    assert: [
      hasNoError<ListContext, ListResult>(),
      returns<ListContext, ListResult>({ code: 0 }),
      {
        name: "does not list the missing worktree session by default",
        check: (ctx: ListContext) => expect(ctx.records.map((record) => record.name)).not.toEqual(expect.arrayContaining(["missing", "unregistered"])),
      },
      {
        name: "shows long-running execution health",
        check: (ctx: ListContext) => expect(ctx.records.find((record) => record.name === "long-running")).toMatchObject({ status: "running", health: "long_running" }),
      },
    ],
  },
  {
    name: "includes unavailable sessions with the all flag",
    input: { all: true },
    assert: [
      hasNoError<ListContext, ListResult>(),
      returns<ListContext, ListResult>({ code: 0 }),
      {
        name: "lists the missing worktree session when requested",
        check: (ctx: ListContext) => expect(ctx.records.find((record) => record.name === "missing")).toMatchObject({ resume: "unavailable", resume_reason: "worktree_missing", worktree_state: "missing" }),
      },
      {
        name: "reports a worktree path that is no longer registered",
        check: (ctx: ListContext) => expect(ctx.records.find((record) => record.name === "unregistered")).toMatchObject({ resume: "unavailable", resume_reason: "worktree_unregistered", worktree_state: "unregistered" }),
      },
      hasObserved<ListContext, ListResult>("records", expect.arrayContaining([expect.objectContaining({ name: "long-running", health: "long_running" })])),
    ],
  },
] satisfies readonly OperationCase<"default", ListInput, ListResult, ListContext>[];

const listTable: OperationTable<ListFixture, "default", ListInput, ListResult, ListContext> = {
  defaultFixture: createListFixture,
  cases: listCases,
  execute: async (fixture, input) => {
    const command = new MuximoCommand({
      cwd: fixture.workspace,
      databaseFile: fixture.database,
      env: { ...process.env, MUXIMOD_DB_FILE: fixture.database },
      io: { out: fixture.output, err: fixture.output },
    });
    try {
      return { code: await command.execute(["list", "--json", ...(input.all ? ["--all"] : [])]) };
    } finally {
      command.close();
    }
  },
  observe: (fixture) => ({
    output: fixture.output.value(),
    records: fixture.output.value()
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  }),
};

type CleanupContext = {
  output: string;
};

const cleanupCases = [
  {
    name: "refuses to remove a live long-running session",
    input: undefined,
    assert: [hasError<CleanupContext, number>({ message: /is still running/ })],
  },
] satisfies readonly OperationCase<"default", undefined, number, CleanupContext>[];

const cleanupTable: OperationTable<ListFixture, "default", undefined, number, CleanupContext> = {
  defaultFixture: createListFixture,
  cases: cleanupCases,
  execute: async (fixture) => {
    const command = new MuximoCommand({
      cwd: fixture.workspace,
      databaseFile: fixture.database,
      env: { ...process.env, MUXIMOD_DB_FILE: fixture.database },
      io: { out: fixture.output, err: fixture.output },
    });
    try {
      return await command.execute(["cleanup", "--force", "long-running"]);
    } finally {
      command.close();
    }
  },
  observe: (fixture) => ({ output: fixture.output.value() }),
};

describe("muximo session list command", () => {
  runOperationTable(it as unknown as TestRegistrar, listTable);
  runOperationTable(it as unknown as TestRegistrar, cleanupTable);
});

async function createListFixture(registerCleanup?: CleanupRegistrar): Promise<FixtureHandle<ListFixture>> {
  const root = mkdtempSync(join(tmpdir(), "muximo-session-list-test-"));
  const workspace = join(root, "workspace");
  const unregisteredWorktree = join(root, "unregistered-worktree");
  const database = join(root, "muximod.sqlite");
  mkdirSync(workspace, { recursive: true });
  const workspaceRoot = realpathSync(workspace);
  mkdirSync(unregisteredWorktree, { recursive: true });
  execFileSync("git", ["init", "-q", workspace]);
  execFileSync("git", ["-C", workspace, "config", "user.email", "agent@example.invalid"]);
  execFileSync("git", ["-C", workspace, "config", "user.name", "Agent Test"]);
  execFileSync("git", ["-C", workspace, "commit", "--allow-empty", "-q", "-m", "fixture"]);

  const now = Date.now();
  const old = new Date(now - 31 * 24 * 60 * 60 * 1_000).toISOString();
  const databaseHandle = createAgentDatabase(database);
  const workspaceId = workspaceIdForPath(workspaceRoot);
  await new DrizzleWorkspaceRepository(databaseHandle.db).upsert(Workspace.create({
    id: workspaceId,
    rootPath: workspaceRoot,
    name: "workspace",
    isGit: true,
    worktreeCopyPatterns: [],
    createdAt: old,
    updatedAt: old,
  }));
  const sessions = new DrizzleAgentSessionRepository(databaseHandle.db);
  await sessions.insert(sessionFixture({
    id: AgentSessionId.create("missing-id"),
    name: "missing",
    status: "exited",
    workspaceId,
    workspaceRoot,
    worktreePath: join(root, "deleted-worktree"),
    updatedAt: old,
    createdAt: old,
  }));
  await sessions.insert(sessionFixture({
    id: AgentSessionId.create("long-running-id"),
    name: "long-running",
    status: "running",
    workspaceId,
    workspaceRoot,
    useWorktree: false,
    worktreeRoot: undefined,
    worktreePath: undefined,
    branch: undefined,
    baseCommit: undefined,
    executionId: "long-running-execution",
    executionPid: process.pid,
    executionStartedAt: old,
    updatedAt: old,
    createdAt: old,
  }));
  await sessions.insert(sessionFixture({
    id: AgentSessionId.create("unregistered-id"),
    name: "unregistered",
    status: "exited",
    workspaceId,
    workspaceRoot: workspace,
    worktreePath: unregisteredWorktree,
    updatedAt: old,
    createdAt: old,
  }));
  databaseHandle.sqlite.prepare("UPDATE agent_sessions SET updated_at = ? WHERE id IN (?, ?, ?)").run(old, "missing-id", "unregistered-id", "long-running-id");
  databaseHandle.close();

  const fixture: ListFixture = { root, workspace, database, output: captureOutput() };
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  if (registerCleanup) {
    registerCleanup(cleanup);
    return { fixture };
  }
  return { fixture, cleanup };
}

function sessionFixture(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return AgentSession.create({
    id: AgentSessionId.create("session-id"),
    name: "session",
    backend: "claude",
    status: "exited",
    workspaceId: WorkspaceId.create("workspace-id"),
    workspaceRoot: "/workspace",
    workspaceName: "workspace",
    worktreeRoot: "/worktrees",
    worktreePath: "/worktrees/session",
    branch: "muximo/session",
    baseCommit: "base-commit",
    useWorktree: true,
    backendSessionId: "backend-session-id",
    setupRan: false,
    resuming: false,
    lastExitStatus: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  });
}

function captureOutput(): Writable & { value: () => string } {
  let value = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    },
  }) as Writable & { value: () => string };
  output.value = () => value;
  return output;
}
