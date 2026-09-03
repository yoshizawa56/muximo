import { Database as BunDatabase } from "bun:sqlite";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentExecutionReceipt } from "@muximo/application";
import {
  AgentSession,
  AgentSessionId,
  type AgentSessionRecord,
  clearPatch,
  Pane,
  PaneId,
  type PaneRecord,
  Workspace,
  WorkspaceId,
  type WorkspaceRecord,
} from "@muximo/domain";
import {
  type Assertion,
  type CleanupRegistrar,
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import {
  createAgentDatabase,
  createMigrationSchemaSynchronizer,
  DrizzleAgentSessionRepository,
  DrizzlePaneRepository,
  DrizzleWorkspaceRepository,
  defaultAgentMigrationsFolder,
  recordAuditEvent,
} from "./index.js";
import { auditEvents } from "./schema.js";

const migrationSchemaSynchronizer = createMigrationSchemaSynchronizer();

const pane: PaneRecord = Pane.create({
  id: PaneId.create("pane-1"),
  hostPaneId: "%1",
  hostServerId: "scope-current:server-current",
  sessionName: "muximod",
  windowId: "@0",
  kind: "agent",
  name: "review",
  cwd: "/work/repo",
  workspaceId: WorkspaceId.create("workspace-1"),
  agentId: "codex",
  initialState: "waiting_input",
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
  setupRan: true,
  resuming: false,
  baselineStatus: "",
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
  legacyPaneAfterMigration?: PaneRecord;
  currentPaneAfterMigration?: PaneRecord;
  claimResults: boolean[];
  backendResults: boolean[];
  ownerAttachResult?: boolean;
  abandonedClaimResults: boolean[];
  abandonedAttachResult?: boolean;
};
type DatabaseKey = "default" | "pending" | "restart" | "legacy-pane-migration" | "auth-migration";
type DatabaseStep =
  | { type: "write-round-trip" }
  | { type: "verify-timestamp-preservation" }
  | { type: "verify-pending" }
  | { type: "verify-restart" }
  | { type: "verify-legacy-pane-migration" }
  | { type: "verify-generations" }
  | { type: "verify-upsert-identity" }
  | { type: "verify-agent-association" }
  | { type: "verify-auth-migration" }
  | { type: "verify-execution-claim" }
  | { type: "verify-atomic-claim-timestamp" }
  | { type: "verify-execution-owner" }
  | { type: "verify-abandoned-execution-claim" }
  | { type: "verify-execution-receipt" }
  | { type: "verify-execution-receipt-retention" };
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
  legacyPaneAfterMigration: PaneRecord | undefined;
  currentPaneAfterMigration: PaneRecord | undefined;
  identityPane: PaneRecord | undefined;
  adoptedPane: PaneRecord | undefined;
  pruneCount: number | undefined;
  claimResults: readonly boolean[];
  backendResults: readonly boolean[];
  authPairingColumns: readonly string[];
  authPairingCount: number;
  claimSession: AgentSessionRecord | undefined;
  ownerAttachResult: boolean | undefined;
  ownerSession: AgentSessionRecord | undefined;
  abandonedClaimResults: readonly boolean[];
  abandonedAttachResult: boolean | undefined;
  abandonedSession: AgentSessionRecord | undefined;
  timestampWorkspace: { name: string; createdAt: string; updatedAt: string } | undefined;
  timestampSession: { name: string; createdAt: string; updatedAt: string } | undefined;
  tmuxServerDefault: string | null | undefined;
  receipt: AgentExecutionReceipt | undefined;
  currentReceipt: AgentExecutionReceipt | undefined;
  expiredReceipt: AgentExecutionReceipt | undefined;
  receiptCount: number;
};

const normalFixture = (): FixtureHandle<DatabaseFixture> => {
  const database = createAgentDatabase(":memory:", { schemaSynchronizer: migrationSchemaSynchronizer });
  return {
    fixture: { database, claimResults: [], backendResults: [], abandonedClaimResults: [] },
    cleanup: () => database.close(),
  };
};

const restartFixture = async (registerCleanup?: CleanupRegistrar): Promise<FixtureHandle<DatabaseFixture>> => {
  const root = mkdtempSync(join(tmpdir(), "muximo-persistence-restart-"));
  registerCleanup?.(() => rmSync(root, { recursive: true, force: true }));
  const migrationsFolder = join(root, "drizzle");
  cpSync(defaultAgentMigrationsFolder(), migrationsFolder, { recursive: true });
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 5);
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  rmSync(join(migrationsFolder, "0006_remove_tmux_server_default.sql"));
  rmSync(join(migrationsFolder, "meta", "0006_snapshot.json"));
  rmSync(join(migrationsFolder, "0007_remarkable_mac_gargan.sql"));
  rmSync(join(migrationsFolder, "meta", "0007_snapshot.json"));

  const file = join(root, "muximod.sqlite");
  const beforeRestart = createAgentDatabase(file, {
    migrationsFolder,
    schemaSynchronizer: migrationSchemaSynchronizer,
  });
  try {
    await new DrizzlePaneRepository(beforeRestart.db).upsert(pane);
  } finally {
    beforeRestart.close();
  }
  const database = createAgentDatabase(file, { schemaSynchronizer: migrationSchemaSynchronizer });
  return {
    fixture: { database, root, claimResults: [], backendResults: [], abandonedClaimResults: [] },
    cleanup: () => database.close(),
  };
};

const legacyPaneMigrationFixture = async (
  registerCleanup?: CleanupRegistrar,
): Promise<FixtureHandle<DatabaseFixture>> => {
  const root = mkdtempSync(join(tmpdir(), "muximo-persistence-legacy-pane-"));
  registerCleanup?.(() => rmSync(root, { recursive: true, force: true }));
  const migrationsFolder = join(root, "drizzle");
  cpSync(defaultAgentMigrationsFolder(), migrationsFolder, { recursive: true });
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; version: string; when: number; tag: string; breakpoints: boolean }>;
  };
  journal.entries = journal.entries.filter((entry) => entry.idx <= 5);
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  rmSync(join(migrationsFolder, "0006_remove_tmux_server_default.sql"));
  rmSync(join(migrationsFolder, "meta", "0006_snapshot.json"));
  rmSync(join(migrationsFolder, "0007_remarkable_mac_gargan.sql"));
  rmSync(join(migrationsFolder, "meta", "0007_snapshot.json"));

  const file = join(root, "muximod.sqlite");
  const beforeMigration = createAgentDatabase(file, {
    migrationsFolder,
    schemaSynchronizer: migrationSchemaSynchronizer,
  });
  try {
    const panes = new DrizzlePaneRepository(beforeMigration.db);
    await panes.upsert({ ...pane, id: PaneId.create("pane-legacy-migrated"), hostServerId: "legacy" });
    await panes.upsert({
      ...pane,
      id: PaneId.create("pane-current-migrated"),
      hostServerId: "scope-current:server-current",
    });
  } finally {
    beforeMigration.close();
  }

  const database = createAgentDatabase(file, { schemaSynchronizer: migrationSchemaSynchronizer });
  return {
    fixture: { database, root, claimResults: [], backendResults: [], abandonedClaimResults: [] },
    cleanup: () => database.close(),
  };
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
  journal.entries.push({
    idx: lastEntry.idx + 1,
    version: lastEntry.version,
    when: lastEntry.when + 1,
    tag: "0001_migration_probe",
    breakpoints: false,
  });
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
  writeFileSync(
    join(migrationsFolder, "0001_migration_probe.sql"),
    "CREATE TABLE migration_probe (id integer PRIMARY KEY);\n",
  );
  const database = createAgentDatabase(":memory:", {
    migrationsFolder,
    schemaSynchronizer: migrationSchemaSynchronizer,
  });
  return {
    fixture: { database, root, claimResults: [], backendResults: [], abandonedClaimResults: [] },
    cleanup: () => database.close(),
  };
};

const authMigrationFixture = (registerCleanup?: CleanupRegistrar): FixtureHandle<DatabaseFixture> => {
  const root = mkdtempSync(join(tmpdir(), "muximo-persistence-auth-"));
  const file = join(root, "muximod.sqlite");
  const sqlite = new BunDatabase(file);
  sqlite.exec(`
    CREATE TABLE auth_pairings (
      pairing_id TEXT PRIMARY KEY NOT NULL,
      server_id TEXT NOT NULL,
      web_origin TEXT NOT NULL DEFAULT '',
      muximod_base_url TEXT NOT NULL,
      secret_hash TEXT NOT NULL UNIQUE,
      claim_token_hash TEXT UNIQUE,
      status TEXT NOT NULL,
      offered_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      claim_expires_at TEXT,
      claimed_at TEXT,
      approved_at TEXT,
      pending_public_key_jwk TEXT,
      pending_fingerprint TEXT,
      pending_display_name TEXT,
      pending_device_type TEXT,
      pending_platform TEXT,
      pending_client_version TEXT,
      device_id TEXT
    );
    CREATE INDEX auth_pairings_status_index ON auth_pairings (status);
  `);
  sqlite
    .prepare(
      `INSERT INTO auth_pairings (
        pairing_id, server_id, web_origin, muximod_base_url, secret_hash, status, offered_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "pairing-1",
      "server-1",
      "",
      "https://muximod.example",
      "secret-hash",
      "offered",
      "2026-08-23T00:00:00.000Z",
      "2026-08-24T00:00:00.000Z",
    );
  sqlite.close();
  const database = createAgentDatabase(file, { schemaSynchronizer: migrationSchemaSynchronizer });
  registerCleanup?.(() => {
    database.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { fixture: { database, root, claimResults: [], backendResults: [], abandonedClaimResults: [] } };
};

const matchesObserved = <Result>(
  key: keyof DatabaseContext,
  expected: unknown,
): Assertion<DatabaseContext, Result> => ({
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
      hasObserved<DatabaseContext, DatabaseResult>("workspace", workspace),
      hasObserved<DatabaseContext, DatabaseResult>("session", session),
      hasObserved<DatabaseContext, DatabaseResult>("auditCount", 1),
      hasObserved<DatabaseContext, DatabaseResult>("migrationCount", 11),
    ],
  },
  {
    name: "preserves entity timestamps through workspace and session updates",
    steps: [{ type: "verify-timestamp-preservation" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("timestampWorkspace", {
        name: "timestamped-updated",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      }),
      hasObserved<DatabaseContext, DatabaseResult>("timestampSession", {
        name: "timestamped-updated",
        createdAt: "2026-08-13T00:00:00.000Z",
        updatedAt: "2026-08-12T00:00:00.000Z",
      }),
    ],
  },
  {
    name: "applies a pending generated migration at startup",
    fixture: "pending",
    steps: [{ type: "verify-pending" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("probeCount", 1),
      hasObserved<DatabaseContext, DatabaseResult>("migrationCount", 12),
    ],
  },
  {
    name: "applies the next migration when reopening a database at the previous migration",
    fixture: "restart",
    steps: [{ type: "verify-restart" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("pane", pane),
      hasObserved<DatabaseContext, DatabaseResult>("migrationCount", 11),
      hasObserved<DatabaseContext, DatabaseResult>("tmuxServerDefault", null),
    ],
  },
  {
    name: "discards panes without a current tmux server identity during migration",
    fixture: "legacy-pane-migration",
    steps: [{ type: "verify-legacy-pane-migration" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("legacyPaneAfterMigration", undefined),
      matchesObserved<DatabaseResult>("currentPaneAfterMigration", { id: "pane-current-migrated" }),
      hasObserved<DatabaseContext, DatabaseResult>("migrationCount", 11),
    ],
  },
  {
    name: "keeps host server generations distinct and prunes only stale rows",
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
    name: "upserts concurrently discovered rows by host identity without changing the stored id",
    steps: [{ type: "verify-upsert-identity" }],
    assert: [matchesObserved<DatabaseResult>("identityPane", { id: "first", name: "updated" })],
  },
  {
    name: "round-trips the live agent session association separately from pane identity",
    steps: [{ type: "verify-agent-association" }],
    assert: [
      matchesObserved<DatabaseResult>("adoptedPane", {
        id: "pane-adopted",
        agentSessionId: session.id,
        agentExecutionId: "execution-id-123456",
      }),
    ],
  },
  {
    name: "migrates the removed auth pairing column without losing rows",
    fixture: "auth-migration",
    steps: [{ type: "verify-auth-migration" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("authPairingColumns", [
        "pairing_id",
        "server_id",
        "muximod_base_url",
        "secret_hash",
        "claim_token_hash",
        "status",
        "offered_at",
        "expires_at",
        "claim_expires_at",
        "claimed_at",
        "approved_at",
        "pending_public_key_jwk",
        "pending_fingerprint",
        "pending_display_name",
        "pending_device_type",
        "pending_platform",
        "pending_client_version",
        "device_id",
      ]),
      hasObserved<DatabaseContext, DatabaseResult>("authPairingCount", 1),
    ],
  },
  {
    name: "claims one agent execution and persists a discovered backend session ID atomically",
    steps: [{ type: "verify-execution-claim" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("claimResults", [true, false]),
      hasObserved<DatabaseContext, DatabaseResult>("backendResults", [true, false]),
      matchesObserved<DatabaseResult>("claimSession", {
        executionId: "execution-1",
        executionPid: 1001,
        backendSessionId: "codex-discovered",
      }),
    ],
  },
  {
    name: "persists the application timestamp during an atomic execution claim",
    steps: [{ type: "verify-atomic-claim-timestamp" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("claimResults", [true]),
      matchesObserved<DatabaseResult>("claimSession", {
        executionId: "execution-timestamped",
        executionPid: 1003,
        executionStartedAt: "2026-08-14T12:02:00.000Z",
        updatedAt: "2026-08-14T12:02:01.000Z",
      }),
    ],
  },
  {
    name: "round-trips and atomically matches the CLI execution owner during attach",
    steps: [{ type: "verify-execution-owner" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("ownerAttachResult", true),
      matchesObserved<DatabaseResult>("ownerSession", {
        executionId: "execution-owner",
        executionPid: 1004,
        executionStartedAt: "2026-08-14T12:04:00.000Z",
        executionOwnerPid: 701,
        executionOwnerStartedAt: "2026-08-14T12:03:00.000Z",
      }),
    ],
  },
  {
    name: "claims abandoned executions before disposal and rejects a late attach",
    steps: [{ type: "verify-abandoned-execution-claim" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("abandonedClaimResults", [true, false]),
      hasObserved<DatabaseContext, DatabaseResult>("abandonedAttachResult", false),
      matchesObserved<DatabaseResult>("abandonedSession", {
        status: "recovering",
        executionId: "execution-abandoned",
        executionPid: 1005,
        executionOwnerPid: 701,
      }),
    ],
  },
  {
    name: "retains a completion receipt after the session is finalized",
    steps: [{ type: "verify-execution-receipt" }],
    assert: [
      matchesObserved<DatabaseResult>("receipt", {
        operation: "run",
        agentSessionId: session.id,
        executionId: "execution-receipt",
        process: { started: true, code: 0, interrupted: false },
        cleanup: { disposition: "not_requested", reason: "no_worktree" },
      }),
    ],
  },
  {
    name: "prunes completion receipts older than the replay retention window",
    steps: [{ type: "verify-execution-receipt-retention" }],
    assert: [
      hasObserved<DatabaseContext, DatabaseResult>("expiredReceipt", undefined),
      matchesObserved<DatabaseResult>("currentReceipt", { executionId: "execution-receipt-current" }),
      hasObserved<DatabaseContext, DatabaseResult>("receiptCount", 1),
    ],
  },
] satisfies readonly ScenarioCase<DatabaseKey, DatabaseStep, DatabaseResult, DatabaseContext>[];

const table: ScenarioTable<DatabaseFixture, DatabaseKey, DatabaseStep, DatabaseResult, DatabaseContext> = {
  defaultFixture: normalFixture,
  fixtures: {
    default: normalFixture,
    pending: pendingMigrationFixture,
    restart: restartFixture,
    "legacy-pane-migration": legacyPaneMigrationFixture,
    "auth-migration": authMigrationFixture,
  },
  cases,
  execute: async (fixture, steps) => {
    const databases = fixture.database;
    for (const step of steps) {
      switch (step.type) {
        case "write-round-trip":
          await new DrizzlePaneRepository(databases.db).upsert(pane);
          await new DrizzleWorkspaceRepository(databases.db).upsert(workspace);
          await new DrizzleAgentSessionRepository(databases.db).insert(session);
          recordAuditEvent(databases.db, {
            eventType: "agent_session.waiting",
            entityId: session.id,
            payload: { state: "waiting_input" },
            occurredAt: "2026-08-09T00:01:00.000Z",
          });
          break;
        case "verify-timestamp-preservation": {
          const workspaces = new DrizzleWorkspaceRepository(databases.db);
          const timestampedWorkspace = Workspace.create({
            ...workspace,
            id: WorkspaceId.create("workspace-timestamps"),
            name: "timestamped",
            createdAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
          });
          await workspaces.insert(timestampedWorkspace);
          await workspaces.upsert(
            Workspace.create({
              ...timestampedWorkspace,
              name: "timestamped-updated",
              createdAt: "2026-08-13T00:00:00.000Z",
              updatedAt: "2026-08-12T00:00:00.000Z",
            }),
          );

          const sessions = new DrizzleAgentSessionRepository(databases.db);
          const timestampedSession = AgentSession.create({
            ...session,
            id: AgentSessionId.create("session-timestamps"),
            name: "timestamped",
            createdAt: "2026-08-10T00:00:00.000Z",
            updatedAt: "2026-08-11T00:00:00.000Z",
          });
          await sessions.insert(timestampedSession);
          await sessions.update(
            AgentSession.update(timestampedSession, {
              name: "timestamped-updated",
              createdAt: "2026-08-13T00:00:00.000Z",
              updatedAt: "2026-08-12T00:00:00.000Z",
            }),
          );
          break;
        }
        case "verify-pending":
          break;
        case "verify-restart":
          break;
        case "verify-legacy-pane-migration":
          break;
        case "verify-generations": {
          const panes = new DrizzlePaneRepository(databases.db);
          const oldPane = {
            ...pane,
            id: PaneId.create("pane-old"),
            hostPaneId: "%0",
            hostServerId: "scope-current:server-old",
            lastSeenAt: "2026-08-01T00:00:00.000Z",
          } satisfies PaneRecord;
          const currentPane = {
            ...pane,
            id: PaneId.create("pane-current"),
            hostPaneId: "%0",
            hostServerId: "scope-current:server-current",
            lastSeenAt: "2026-08-10T00:00:00.000Z",
          } satisfies PaneRecord;
          await panes.upsert(oldPane);
          await panes.upsert(currentPane);
          fixture.prePruneOld = await panes.findByHostPaneIdentity("scope-current:server-old", "%0");
          fixture.prePruneCurrent = await panes.findByHostPaneIdentity("scope-current:server-current", "%0");
          fixture.pruneCount = await panes.pruneStalePanes(
            [currentPane.id],
            "2026-08-09T00:00:00.000Z",
            "scope-current",
          );
          break;
        }
        case "verify-upsert-identity": {
          const panes = new DrizzlePaneRepository(databases.db);
          await panes.upsert({ ...pane, id: PaneId.create("first"), hostServerId: "server-1" });
          await panes.upsert({ ...pane, id: PaneId.create("second"), hostServerId: "server-1", name: "updated" });
          break;
        }
        case "verify-agent-association": {
          const panes = new DrizzlePaneRepository(databases.db);
          await panes.upsert({
            ...pane,
            id: PaneId.create("pane-adopted"),
            agentSessionId: session.id,
            agentExecutionId: "execution-id-123456",
          } satisfies PaneRecord);
          break;
        }
        case "verify-auth-migration":
          break;
        case "verify-execution-claim": {
          const sessions = new DrizzleAgentSessionRepository(databases.db);
          await sessions.insert(AgentSession.update(session, { backendSessionId: clearPatch }));
          fixture.claimResults.push(
            await sessions.claimExecution({
              id: session.id,
              expectedExecutionPid: null,
              executionOwnerPid: null,
              executionOwnerStartedAt: null,
              executionId: "execution-1",
              executionPid: 1001,
              executionStartedAt: "2026-08-14T12:00:00.000Z",
              updatedAt: "2026-08-14T12:00:01.000Z",
            }),
          );
          fixture.claimResults.push(
            await sessions.claimExecution({
              id: session.id,
              expectedExecutionPid: null,
              executionOwnerPid: null,
              executionOwnerStartedAt: null,
              executionId: "execution-2",
              executionPid: 1002,
              executionStartedAt: "2026-08-14T12:01:00.000Z",
              updatedAt: "2026-08-14T12:01:01.000Z",
            }),
          );
          fixture.backendResults.push(await sessions.setBackendSessionIdIfMissing(session.id, "codex-discovered"));
          fixture.backendResults.push(await sessions.setBackendSessionIdIfMissing(session.id, "codex-other"));
          break;
        }
        case "verify-atomic-claim-timestamp": {
          const sessions = new DrizzleAgentSessionRepository(databases.db);
          await sessions.insert(session);
          fixture.claimResults.push(
            await sessions.claimExecution({
              id: session.id,
              expectedExecutionPid: null,
              executionOwnerPid: null,
              executionOwnerStartedAt: null,
              executionId: "execution-timestamped",
              executionPid: 1003,
              executionStartedAt: "2026-08-14T12:02:00.000Z",
              updatedAt: "2026-08-14T12:02:01.000Z",
            }),
          );
          break;
        }
        case "verify-execution-owner": {
          const sessions = new DrizzleAgentSessionRepository(databases.db);
          const pending = AgentSession.create({
            ...session,
            id: AgentSessionId.create("session-owner"),
            name: "owner",
            executionId: "execution-owner",
            executionStartedAt: "2026-08-14T12:03:00.000Z",
            executionOwnerPid: 701,
            executionOwnerStartedAt: "2026-08-14T12:03:00.000Z",
          });
          await sessions.insert(pending);
          fixture.ownerAttachResult = await sessions.attachExecution({
            id: pending.id,
            executionId: pending.executionId ?? "",
            expectedExecutionOwnerPid: pending.executionOwnerPid ?? null,
            expectedExecutionOwnerStartedAt: pending.executionOwnerStartedAt ?? null,
            executionPid: 1004,
            executionStartedAt: "2026-08-14T12:04:00.000Z",
            updatedAt: "2026-08-14T12:04:01.000Z",
          });
          break;
        }
        case "verify-abandoned-execution-claim": {
          const sessions = new DrizzleAgentSessionRepository(databases.db);
          const abandoned = AgentSession.create({
            ...session,
            id: AgentSessionId.create("session-abandoned"),
            name: "abandoned",
            executionId: "execution-abandoned",
            executionPid: 1005,
            executionStartedAt: "2026-08-14T12:05:00.000Z",
            executionOwnerPid: 701,
            executionOwnerStartedAt: "2026-08-14T12:04:00.000Z",
          });
          await sessions.insert(abandoned);
          const claim = {
            id: abandoned.id,
            executionId: abandoned.executionId ?? "",
            expectedExecutionPid: abandoned.executionPid ?? null,
            expectedExecutionStartedAt: abandoned.executionStartedAt ?? null,
            expectedExecutionOwnerPid: abandoned.executionOwnerPid ?? null,
            expectedExecutionOwnerStartedAt: abandoned.executionOwnerStartedAt ?? null,
            updatedAt: "2026-08-14T12:06:00.000Z",
          };
          fixture.abandonedClaimResults.push(await sessions.claimAbandonedExecution(claim));
          fixture.abandonedClaimResults.push(await sessions.claimAbandonedExecution(claim));
          fixture.abandonedAttachResult = await sessions.attachExecution({
            id: abandoned.id,
            executionId: abandoned.executionId ?? "",
            expectedExecutionOwnerPid: abandoned.executionOwnerPid ?? null,
            expectedExecutionOwnerStartedAt: abandoned.executionOwnerStartedAt ?? null,
            executionPid: 1006,
            executionStartedAt: "2026-08-14T12:06:01.000Z",
            updatedAt: "2026-08-14T12:06:01.000Z",
          });
          break;
        }
        case "verify-execution-receipt": {
          const sessions = new DrizzleAgentSessionRepository(databases.db);
          const finalized = AgentSession.update(session, {
            status: "exited",
            lastExitStatus: 0,
            updatedAt: "2026-08-14T12:03:00.000Z",
          });
          await sessions.saveExecutionReceipt({
            operation: "run",
            agentSessionId: finalized.id,
            executionId: "execution-receipt",
            process: { started: true, code: 0, interrupted: false },
            session: finalized,
            cleanup: { disposition: "not_requested", reason: "no_worktree" },
          });
          break;
        }
        case "verify-execution-receipt-retention": {
          const sessions = new DrizzleAgentSessionRepository(databases.db);
          const expiredSession = AgentSession.create({
            ...session,
            id: AgentSessionId.create("session-receipt-expired"),
            name: "expired-receipt",
            updatedAt: "2026-08-01T00:00:00.000Z",
          });
          const currentSession = AgentSession.create({
            ...session,
            id: AgentSessionId.create("session-receipt-current"),
            name: "current-receipt",
            updatedAt: "2026-08-14T00:00:00.000Z",
          });
          await sessions.saveExecutionReceipt({
            operation: "run",
            agentSessionId: expiredSession.id,
            executionId: "execution-receipt-expired",
            process: { started: true, code: 0, interrupted: false },
            session: expiredSession,
            cleanup: { disposition: "not_requested", reason: "no_worktree" },
          });
          await sessions.saveExecutionReceipt({
            operation: "run",
            agentSessionId: currentSession.id,
            executionId: "execution-receipt-current",
            process: { started: true, code: 0, interrupted: false },
            session: currentSession,
            cleanup: { disposition: "not_requested", reason: "no_worktree" },
          });
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
    return {
      pane: await panes.findById(pane.id),
      waitingPanes: await panes.list({ state: "waiting_input" }),
      workspace: await new DrizzleWorkspaceRepository(database.db).findById(workspace.id),
      session: await sessions.findByName(workspace.id, session.name),
      auditCount: database.db.select().from(auditEvents).all().length,
      migrationCount: database.sqlite.query('SELECT hash, created_at FROM "__drizzle_migrations"').all().length,
      probeCount: database.sqlite
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_probe'")
        .all().length,
      oldIdentity: fixture.prePruneOld,
      currentIdentity: fixture.prePruneCurrent,
      oldAfterPrune: await panes.findById(PaneId.create("pane-old")),
      currentAfterPrune: await panes.findById(PaneId.create("pane-current")),
      legacyPaneAfterMigration: await panes.findById(PaneId.create("pane-legacy-migrated")),
      currentPaneAfterMigration: await panes.findById(PaneId.create("pane-current-migrated")),
      identityPane: await panes.findByHostPaneIdentity("server-1", pane.hostPaneId),
      adoptedPane: await panes.findById(PaneId.create("pane-adopted")),
      pruneCount: fixture.pruneCount,
      claimResults: [...fixture.claimResults],
      backendResults: [...fixture.backendResults],
      authPairingColumns: (
        database.sqlite.query("PRAGMA table_info(auth_pairings)").all() as Array<{ name: string }>
      ).map((column) => column.name),
      authPairingCount: (
        database.sqlite.query("SELECT COUNT(*) AS count FROM auth_pairings").get() as { count: number }
      ).count,
      claimSession: await sessions.findById(session.id),
      ownerAttachResult: fixture.ownerAttachResult,
      ownerSession: await sessions.findById(AgentSessionId.create("session-owner")),
      abandonedClaimResults: [...fixture.abandonedClaimResults],
      abandonedAttachResult: fixture.abandonedAttachResult,
      abandonedSession: await sessions.findById(AgentSessionId.create("session-abandoned")),
      timestampWorkspace: await readWorkspaceTimestamps(database, "workspace-timestamps"),
      timestampSession: await readSessionTimestamps(database, "session-timestamps"),
      tmuxServerDefault: (
        database.sqlite.query("PRAGMA table_info(panes)").all() as Array<{ name: string; dflt_value: string | null }>
      ).find((column) => column.name === "tmux_server_id")?.dflt_value,
      receipt: await sessions.findExecutionReceipt("execution-receipt"),
      currentReceipt: await sessions.findExecutionReceipt("execution-receipt-current"),
      expiredReceipt: await sessions.findExecutionReceipt("execution-receipt-expired"),
      receiptCount: (
        database.sqlite.query("SELECT COUNT(*) AS count FROM agent_execution_receipts").get() as { count: number }
      ).count,
    };
  },
};

describe("sqlite persistence", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

function assertNever(value: never): never {
  throw new Error(`unhandled persistence step: ${String(value)}`);
}

async function readWorkspaceTimestamps(
  database: Database,
  id: string,
): Promise<{ name: string; createdAt: string; updatedAt: string } | undefined> {
  const record = await new DrizzleWorkspaceRepository(database.db).findById(WorkspaceId.create(id));
  return record ? { name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt } : undefined;
}

async function readSessionTimestamps(
  database: Database,
  id: string,
): Promise<{ name: string; createdAt: string; updatedAt: string } | undefined> {
  const record = await new DrizzleAgentSessionRepository(database.db).findById(AgentSessionId.create(id));
  return record ? { name: record.name, createdAt: record.createdAt, updatedAt: record.updatedAt } : undefined;
}
