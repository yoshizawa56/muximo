import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasObserved,
  runScenarioTable,
  type Assertion,
  type CleanupRegistrar,
  type FixtureHandle,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import {
  AgentSession,
  AgentSessionId,
  clearPatch,
  Pane,
  PaneId,
  Workspace,
  WorkspaceId,
  type AgentSessionRecord,
  type PaneRecord,
  type WorkspaceRecord,
} from "@muximo/domain";
import {
  defaultAgentMigrationsFolder,
  DrizzleAgentSessionRepository,
  DrizzlePaneRepository,
  DrizzleWorkspaceRepository,
  createAgentDatabase,
  recordAuditEvent,
} from "./index.js";
import { auditEvents } from "./schema.js";

const pane: PaneRecord = Pane.create({
  id: PaneId.create("pane-1"),
  tmuxPaneId: "%1",
  sessionName: "muximod",
  windowId: "@0",
  kind: "agent",
  name: "review",
  cwd: "/work/repo",
  workspaceId: WorkspaceId.create("workspace-1"),
  agentId: "codex",
  state: "waiting_input",
  title: "Review changes",
  lastSeenAt: "2026-08-09T00:00:00.000Z",
});

const workspace: WorkspaceRecord = Workspace.create({
  id: WorkspaceId.create("workspace-1"),
  rootPath: "/work/repo",
  name: "repo",
  isGit: true,
  setupScriptPath: "/config/hooks/setup",
  cleanupScriptPath: "/config/hooks/cleanup",
  worktreeCopyPatterns: [".env", "config/*.local.json"],
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
});

const session: AgentSessionRecord = AgentSession.create({
  id: AgentSessionId.create("session-1"),
  name: "review",
  backend: "codex",
  status: "running",
  workspaceId: workspace.id,
  workspaceRoot: "/work/repo",
  workspaceName: "repo",
  worktreeRoot: "/work/repo.worktrees",
  worktreePath: "/work/repo.worktrees/review",
  branch: "muximo/review",
  baseCommit: "abc123",
  useWorktree: true,
  setupHook: workspace.setupScriptPath,
  cleanupHook: workspace.cleanupScriptPath,
  setupOutputFile: "/state/setup.log",
  backendSessionId: "codex-session",
  codexProfile: "local-agent",
  codexRemote: "unix://",
  setupRan: true,
  resuming: false,
  baselineStatus: "",
  codexSessionBaseline: JSON.stringify({ codexSessions: [] }),
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:00.000Z",
});

type Database = ReturnType<typeof createAgentDatabase>;
type DatabaseFixture = {
  database: Database;
  root?: string;
  pruneCount?: number;
  prePruneOld?: PaneRecord;
  prePruneCurrent?: PaneRecord;
  claimResults: boolean[];
  backendResults: boolean[];
};
type DatabaseKey = "historical" | "legacy" | "pending";
type DatabaseStep =
  | { type: "write-round-trip" }
  | { type: "verify-legacy" }
  | { type: "verify-pending" }
  | { type: "verify-generations" }
  | { type: "verify-upsert-identity" }
  | { type: "verify-agent-association" }
  | { type: "verify-execution-claim" };
type DatabaseResult = undefined;
type DatabaseContext = {
  pane: PaneRecord | undefined;
  workspace: WorkspaceRecord | undefined;
  session: AgentSessionRecord | undefined;
  waitingPanes: readonly PaneRecord[];
  auditCount: number;
  migrationCount: number;
  probeCount: number;
  oldIdentity: PaneRecord | undefined;
  currentIdentity: PaneRecord | undefined;
  oldAfterPrune: PaneRecord | undefined;
  currentAfterPrune: PaneRecord | undefined;
  identityPane: PaneRecord | undefined;
  adoptedPane: PaneRecord | undefined;
  pruneCount: number | undefined;
  claimResults: readonly boolean[];
  backendResults: readonly boolean[];
  claimSession: AgentSessionRecord | undefined;
  runTablePresent: boolean;
  runIdColumnPresent: boolean;
  integrityCheck: string;
};

const normalFixture = (): FixtureHandle<DatabaseFixture> => {
  const database = createAgentDatabase();
  return { fixture: { database, claimResults: [], backendResults: [] }, cleanup: () => database.close() };
};

const createPreCleanupMigrationsFolder = (root: string): string => {
  const migrationsFolder = join(root, "drizzle");
  cpSync(defaultAgentMigrationsFolder(), migrationsFolder, { recursive: true });
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.tag !== "0004_remove_legacy_runs");
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  rmSync(join(migrationsFolder, "0004_remove_legacy_runs.sql"));
  return migrationsFolder;
};

const legacyFixture = async (registerCleanup?: CleanupRegistrar): Promise<FixtureHandle<DatabaseFixture>> => {
  const root = mkdtempSync(join(tmpdir(), "muximo-persistence-legacy-"));
  registerCleanup?.(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "muximod.sqlite");
  const initial = createAgentDatabase(file, { migrationsFolder: createPreCleanupMigrationsFolder(root) });
  try {
    await new DrizzlePaneRepository(initial.db).upsert(pane);
    initial.sqlite.exec('ALTER TABLE workspaces DROP COLUMN worktree_copy_patterns; DROP INDEX panes_agent_session_index; ALTER TABLE panes DROP COLUMN agent_session_id; ALTER TABLE panes DROP COLUMN agent_execution_id; DROP INDEX panes_tmux_server_pane_id_index; ALTER TABLE panes DROP COLUMN tmux_server_id; CREATE UNIQUE INDEX panes_tmux_pane_id_index ON panes (tmux_pane_id); ALTER TABLE agent_sessions DROP COLUMN execution_id; ALTER TABLE agent_sessions DROP COLUMN execution_pid; ALTER TABLE agent_sessions DROP COLUMN execution_started_at; DROP TABLE "__drizzle_migrations"');
  } finally {
    initial.close();
  }
  const database = createAgentDatabase(file);
  return { fixture: { database, root, claimResults: [], backendResults: [] }, cleanup: () => database.close() };
};

const historicalMigrationFixture = async (registerCleanup?: CleanupRegistrar): Promise<FixtureHandle<DatabaseFixture>> => {
  const root = mkdtempSync(join(tmpdir(), "muximo-persistence-historical-"));
  registerCleanup?.(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "muximod.sqlite");
  const migrationsFolder = createPreCleanupMigrationsFolder(root);

  const historical = createAgentDatabase(file, { migrationsFolder });
  try {
    await new DrizzlePaneRepository(historical.db).upsert(pane);
    historical.sqlite
      .prepare("INSERT INTO runs (id, pane_id, agent_id, profile_id, state, started_at, ended_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run("legacy-run", pane.id, pane.agentId ?? null, "legacy-profile", pane.state, pane.lastSeenAt, null, pane.lastSeenAt, pane.lastSeenAt);
    historical.sqlite.prepare("UPDATE panes SET run_id = ? WHERE id = ?").run("legacy-run", pane.id);
  } finally {
    historical.close();
  }

  const database = createAgentDatabase(file);
  return { fixture: { database, root, claimResults: [], backendResults: [] }, cleanup: () => database.close() };
};

const pendingMigrationFixture = (registerCleanup?: CleanupRegistrar): FixtureHandle<DatabaseFixture> => {
  const root = mkdtempSync(join(tmpdir(), "muximo-persistence-migrations-"));
  registerCleanup?.(() => rmSync(root, { recursive: true, force: true }));
  const migrationsFolder = join(root, "drizzle");
  cpSync(defaultAgentMigrationsFolder(), migrationsFolder, { recursive: true });
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  const lastEntry = journal.entries.at(-1)!;
  journal.entries.push({ idx: lastEntry.idx + 1, version: lastEntry.version, when: lastEntry.when + 1, tag: "0001_migration_probe", breakpoints: false });
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  writeFileSync(join(migrationsFolder, "0001_migration_probe.sql"), "CREATE TABLE migration_probe (id integer PRIMARY KEY);\n");
  const database = createAgentDatabase(":memory:", { migrationsFolder });
  return { fixture: { database, root, claimResults: [], backendResults: [] }, cleanup: () => database.close() };
};

const matchesObserved = <Result>(key: keyof DatabaseContext, expected: unknown): Assertion<DatabaseContext, Result> => ({
  name: `matches observed ${String(key)}`,
  check: (ctx) => expect(ctx[key]).toMatchObject(expected as object),
});

const cases = [
  {
    name: "round-trips panes, workspaces, sessions, and audit events",
    steps: [{ type: "write-round-trip" }],
    assert: [
      matchesObserved<DatabaseResult>("pane", pane),
      hasObserved<DatabaseContext, DatabaseResult>("waitingPanes", [pane]),
      matchesObserved<DatabaseResult>("workspace", { ...workspace, updatedAt: expect.any(String) }),
      matchesObserved<DatabaseResult>("session", { ...session, updatedAt: expect.any(String) }),
      hasObserved<DatabaseContext, DatabaseResult>("auditCount", 1),
      hasObserved<DatabaseContext, DatabaseResult>("migrationCount", 5),
    ],
  },
  {
    name: "baselines a legacy database while preserving current pane data",
    fixture: "legacy",
    steps: [{ type: "verify-legacy" }],
    assert: [hasObserved<DatabaseContext, DatabaseResult>("pane", pane), hasObserved<DatabaseContext, DatabaseResult>("migrationCount", 5)],
  },
  {
    name: "removes legacy run storage while preserving current pane data",
    fixture: "historical",
    steps: [{ type: "verify-legacy" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("pane", pane),
      hasObserved<DatabaseContext, DatabaseResult>("runTablePresent", false),
      hasObserved<DatabaseContext, DatabaseResult>("runIdColumnPresent", false),
      hasObserved<DatabaseContext, DatabaseResult>("integrityCheck", "ok"),
      hasObserved<DatabaseContext, DatabaseResult>("migrationCount", 5),
    ],
  },
  {
    name: "applies a pending generated migration at startup",
    fixture: "pending",
    steps: [{ type: "verify-pending" }],
    assert: [hasObserved<DatabaseContext, DatabaseResult>("probeCount", 1), hasObserved<DatabaseContext, DatabaseResult>("migrationCount", 6)],
  },
  {
    name: "keeps tmux server generations distinct and prunes only stale rows",
    steps: [{ type: "verify-generations" }],
    assert: [
      matchesObserved<DatabaseResult>("oldIdentity", { id: "pane-old" }),
      matchesObserved<DatabaseResult>("currentIdentity", { id: "pane-current" }),
      hasObserved<DatabaseContext, DatabaseResult>("pruneCount", 1),
      hasObserved<DatabaseContext, DatabaseResult>("oldAfterPrune", undefined),
      matchesObserved<DatabaseResult>("currentAfterPrune", { id: "pane-current" }),
    ],
  },
  {
    name: "upserts concurrently discovered rows by tmux identity without changing the stored id",
    steps: [{ type: "verify-upsert-identity" }],
    assert: [matchesObserved<DatabaseResult>("identityPane", { id: "first", name: "updated" })],
  },
  {
    name: "round-trips the live agent session association separately from pane identity",
    steps: [{ type: "verify-agent-association" }],
    assert: [matchesObserved<DatabaseResult>("adoptedPane", { id: "pane-adopted", agentSessionId: session.id, agentExecutionId: "execution-id-123456" })],
  },
  {
    name: "claims one agent execution and persists a discovered backend session ID atomically",
    steps: [{ type: "verify-execution-claim" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("claimResults", [true, false]),
      hasObserved<DatabaseContext, DatabaseResult>("backendResults", [true, false]),
      matchesObserved<DatabaseResult>("claimSession", { executionId: "execution-1", executionPid: 1001, backendSessionId: "codex-discovered" }),
    ],
  },
] satisfies readonly ScenarioCase<DatabaseKey, DatabaseStep, DatabaseResult, DatabaseContext>[];

const table: ScenarioTable<DatabaseFixture, DatabaseKey, DatabaseStep, DatabaseResult, DatabaseContext> = {
  defaultFixture: normalFixture,
  fixtures: { historical: historicalMigrationFixture, legacy: legacyFixture, pending: pendingMigrationFixture },
  cases,
  execute: async (fixture, steps) => {
    const databases = fixture.database;
    for (const step of steps) {
      switch (step.type) {
        case "write-round-trip":
          await new DrizzlePaneRepository(databases.db).upsert(pane);
          await new DrizzleWorkspaceRepository(databases.db).upsert(workspace);
          await new DrizzleAgentSessionRepository(databases.db).insert(session);
          recordAuditEvent(databases.db, { eventType: "agent_session.waiting", entityId: session.id, payload: { state: "waiting_input" }, occurredAt: "2026-08-09T00:01:00.000Z" });
          break;
        case "verify-legacy":
        case "verify-pending":
          break;
        case "verify-generations": {
          const panes = new DrizzlePaneRepository(databases.db);
          const oldPane = { ...pane, id: PaneId.create("pane-old"), tmuxPaneId: "%0", tmuxServerId: "scope-current:server-old", lastSeenAt: "2026-08-01T00:00:00.000Z" } satisfies PaneRecord;
          const currentPane = { ...pane, id: PaneId.create("pane-current"), tmuxPaneId: "%0", tmuxServerId: "scope-current:server-current", lastSeenAt: "2026-08-10T00:00:00.000Z" } satisfies PaneRecord;
          await panes.upsert(oldPane);
          await panes.upsert(currentPane);
          fixture.prePruneOld = await panes.findByTmuxPaneIdentity("scope-current:server-old", "%0");
          fixture.prePruneCurrent = await panes.findByTmuxPaneIdentity("scope-current:server-current", "%0");
          fixture.pruneCount = await panes.pruneStalePanes([currentPane.id], "2026-08-09T00:00:00.000Z", "scope-current");
          break;
        }
        case "verify-upsert-identity": {
          const panes = new DrizzlePaneRepository(databases.db);
          await panes.upsert({ ...pane, id: PaneId.create("first"), tmuxServerId: "server-1" });
          await panes.upsert({ ...pane, id: PaneId.create("second"), tmuxServerId: "server-1", name: "updated" });
          break;
        }
        case "verify-agent-association": {
          const panes = new DrizzlePaneRepository(databases.db);
          await panes.upsert({ ...pane, id: PaneId.create("pane-adopted"), agentSessionId: session.id, agentExecutionId: "execution-id-123456" } satisfies PaneRecord);
          break;
        }
        case "verify-execution-claim": {
          const sessions = new DrizzleAgentSessionRepository(databases.db);
          await sessions.insert(AgentSession.update(session, { backendSessionId: clearPatch }));
          fixture.claimResults.push(await sessions.claimExecution(session.id, null, "execution-1", 1001, "2026-08-14T12:00:00.000Z"));
          fixture.claimResults.push(await sessions.claimExecution(session.id, null, "execution-2", 1002, "2026-08-14T12:01:00.000Z"));
          fixture.backendResults.push(await sessions.setBackendSessionIdIfMissing(session.id, "codex-discovered"));
          fixture.backendResults.push(await sessions.setBackendSessionIdIfMissing(session.id, "codex-other"));
          break;
        }
        default:
          assertNever(step);
      }
    }
  },
  observe: async (fixture) => {
    const { database } = fixture;
    const panes = new DrizzlePaneRepository(database.db);
    const sessions = new DrizzleAgentSessionRepository(database.db);
    const runTablePresent = database.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'runs'").all().length > 0;
    const paneColumns = database.sqlite.query("PRAGMA table_info(panes)").all() as Array<{ name: string }>;
    const integrity = database.sqlite.query("PRAGMA integrity_check").get() as { integrity_check: string };
    return {
      pane: await panes.findById(pane.id),
      waitingPanes: await panes.list({ state: "waiting_input" }),
      workspace: await new DrizzleWorkspaceRepository(database.db).findById(workspace.id),
      session: await sessions.findByName(workspace.id, session.name),
      auditCount: database.db.select().from(auditEvents).all().length,
      migrationCount: database.sqlite.query('SELECT hash, created_at FROM "__drizzle_migrations"').all().length,
      probeCount: database.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_probe'").all().length,
      runTablePresent,
      runIdColumnPresent: paneColumns.some((column) => column.name === "run_id"),
      integrityCheck: integrity.integrity_check,
      oldIdentity: fixture.prePruneOld,
      currentIdentity: fixture.prePruneCurrent,
      oldAfterPrune: await panes.findById(PaneId.create("pane-old")),
      currentAfterPrune: await panes.findById(PaneId.create("pane-current")),
      identityPane: await panes.findByTmuxPaneIdentity("server-1", pane.tmuxPaneId),
      adoptedPane: await panes.findById(PaneId.create("pane-adopted")),
      pruneCount: fixture.pruneCount,
      claimResults: [...fixture.claimResults],
      backendResults: [...fixture.backendResults],
      claimSession: await sessions.findById(session.id),
    };
  },
};

describe("sqlite persistence", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

function assertNever(value: never): never {
  throw new Error(`unhandled persistence step: ${String(value)}`);
}
