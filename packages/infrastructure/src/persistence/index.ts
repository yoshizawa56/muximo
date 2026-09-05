import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { AgentDrizzleDatabase } from "./database-types.js";
import { embeddedMigrationFiles } from "./embedded-migrations.generated.js";
import type { DatabaseSchemaSynchronizer } from "./schema-sync.js";
import { configureSqliteConnection, defaultSqliteBusyTimeoutMs } from "./sqlite.js";

export type {
  AuthDeviceRecord,
  AuthDeviceStatus,
  AuthDeviceType,
  AuthPairingRecord,
  AuthPairingStatus,
  AuthSessionRecord,
  ClaimPairingInput,
  ClaimPairingResult,
  CreatePairingInput,
  CreatePairingResult,
} from "@muximo/application";
export { AuthStoreError } from "@muximo/application";
export { AuthStore } from "./repositories/sqlite/auth.js";
export {
  DrizzleAgentSessionRepository,
  DrizzlePaneRepository,
  DrizzleRepositoryBase,
  DrizzleWorkspaceRepository,
  recordAuditEvent,
} from "./repositories/sqlite/index.js";
export { agentExecutionReceipts, agentSessions, auditEvents, codexSessionStates, panes, workspaces } from "./schema.js";
export {
  createMigrationSchemaSynchronizer,
  createPushSchemaSynchronizer,
  type DatabaseSchemaSynchronizer,
  type DatabaseSchemaSynchronizerInput,
  MigrationSchemaSynchronizer,
  type PushCommandOptions,
  type PushCommandRunner,
  PushSchemaSynchronizer,
  type PushSchemaSynchronizerOptions,
} from "./schema-sync.js";
export type { SqliteRetryOptions } from "./transaction.js";
export { isRetryableSqliteBusy, runSqliteTransaction, SqliteTransactionManager } from "./transaction.js";

export type AgentDatabase = {
  databaseFile: string;
  db: AgentDrizzleDatabase;
  sqlite: Database;
  openConnection: () => Database;
  close: () => void;
};

export type AgentDatabaseOptions = {
  schemaSynchronizer: DatabaseSchemaSynchronizer;
  environment?: NodeJS.ProcessEnv;
  migrationsFolder?: string;
  busyTimeoutMs?: number;
};

export function defaultAgentDatabaseFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.MUXIMOD_DATABASE_FILE?.trim() || ":memory:";
}

export function createAgentDatabase(file: string | undefined, options: AgentDatabaseOptions): AgentDatabase {
  const environment = options.environment ?? process.env;
  const databaseFile = file ?? defaultAgentDatabaseFile(environment);
  const databasePath = databaseFile === ":memory:" ? databaseFile : resolve(databaseFile);
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(databasePath), 0o700);
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? defaultSqliteBusyTimeoutMs;
  const sqlite = openConfiguredConnection(databasePath, busyTimeoutMs);
  secureDatabaseFiles(databasePath);
  const migrationsFolder =
    options.migrationsFolder ?? findAgentMigrationsFolder(environment) ?? materializeEmbeddedMigrations();
  const db = drizzle({ client: sqlite });
  try {
    options.schemaSynchronizer.synchronize({
      databaseFile: databasePath,
      db,
      sqlite,
      migrationsFolder,
    });
  } catch (error) {
    sqlite.close();
    throw new Error(
      `database schema synchronization failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  ensureAuthSchema(sqlite);
  secureDatabaseFiles(databasePath);

  return {
    databaseFile: databasePath,
    db,
    sqlite,
    openConnection: () => openConfiguredConnection(databasePath, busyTimeoutMs),
    close: () => sqlite.close(),
  };
}

function openConfiguredConnection(databasePath: string, busyTimeoutMs: number): Database {
  return configureSqliteConnection(new Database(databasePath), busyTimeoutMs);
}

function secureDatabaseFiles(databasePath: string): void {
  if (databasePath === ":memory:") return;
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

export function defaultAgentMigrationsFolder(env: NodeJS.ProcessEnv = process.env): string {
  const folder = findAgentMigrationsFolder(env);
  if (!folder) {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const executableDirectory = dirname(process.execPath);
    throw new Error(
      `database migration files not found; set MUXIMOD_MIGRATIONS_DIR (searched: ${[
        env.MUXIMOD_MIGRATIONS_DIR ? resolve(process.cwd(), env.MUXIMOD_MIGRATIONS_DIR) : undefined,
        join(moduleDirectory, "../drizzle"),
        join(executableDirectory, "migrations"),
        join(process.cwd(), "packages/infrastructure/drizzle"),
        join(process.cwd(), "drizzle"),
      ]
        .filter((candidate): candidate is string => Boolean(candidate))
        .join(", ")})`,
    );
  }
  return folder;
}

function findAgentMigrationsFolder(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const configured = env.MUXIMOD_MIGRATIONS_DIR;
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const executableDirectory = dirname(process.execPath);
  const candidates = [
    configured ? resolve(process.cwd(), configured) : undefined,
    join(moduleDirectory, "../drizzle"),
    join(executableDirectory, "migrations"),
    join(process.cwd(), "packages/infrastructure/drizzle"),
    join(process.cwd(), "drizzle"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSync(join(candidate, "meta", "_journal.json")));
}

function materializeEmbeddedMigrations(): string {
  const digest = createHash("sha256")
    .update(embeddedMigrationFiles.map((file) => `${file.path}\0${file.contents}`).join("\0"))
    .digest("hex")
    .slice(0, 16);
  const migrationsFolder = join(tmpdir(), "muximo", "migrations", digest);
  for (const file of embeddedMigrationFiles) {
    const target = join(migrationsFolder, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    if (!existsSync(target) || readFileSync(target, "utf8") !== file.contents) {
      writeFileSync(target, file.contents, { mode: 0o600 });
    }
  }
  return migrationsFolder;
}

// Authentication tables are bootstrapped here because they use a separate
// schema module from the application data migrations.
function ensureAuthSchema(sqlite: Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS auth_metadata (
      id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
      server_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_devices (
      device_id TEXT PRIMARY KEY NOT NULL,
      server_id TEXT NOT NULL,
      public_key_jwk TEXT NOT NULL,
      key_fingerprint TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      device_type TEXT NOT NULL,
      platform TEXT,
      client_version TEXT,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      last_seen_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS auth_devices_status_index ON auth_devices (status);
    CREATE TABLE IF NOT EXISTS auth_pairings (
      pairing_id TEXT PRIMARY KEY NOT NULL,
      server_id TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS auth_pairings_status_index ON auth_pairings (status);
    CREATE TABLE IF NOT EXISTS auth_sessions (
      session_id TEXT PRIMARY KEY NOT NULL,
      server_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_device_index ON auth_sessions (device_id);
    CREATE INDEX IF NOT EXISTS auth_sessions_expiry_index ON auth_sessions (expires_at);
  `);
  migrateAuthPairingsWithoutWebOrigin(sqlite);
}

/** Applies the explicit auth schema change that removed the unused web_origin column. */
function migrateAuthPairingsWithoutWebOrigin(sqlite: Database): void {
  const columns = sqlite.prepare("PRAGMA table_info(auth_pairings)").all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === "web_origin")) return;

  const requiredColumns = [
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
  ];
  const existingColumns = new Set(columns.map((column) => column.name));
  const missingColumn = requiredColumns.find((column) => !existingColumns.has(column));
  if (missingColumn) throw new Error(`auth_pairings schema is missing required column: ${missingColumn}`);

  try {
    sqlite.exec("BEGIN IMMEDIATE");
    sqlite.exec(`
      CREATE TABLE auth_pairings_without_web_origin (
        pairing_id TEXT PRIMARY KEY NOT NULL,
        server_id TEXT NOT NULL,
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
      INSERT INTO auth_pairings_without_web_origin (
        pairing_id,
        server_id,
        muximod_base_url,
        secret_hash,
        claim_token_hash,
        status,
        offered_at,
        expires_at,
        claim_expires_at,
        claimed_at,
        approved_at,
        pending_public_key_jwk,
        pending_fingerprint,
        pending_display_name,
        pending_device_type,
        pending_platform,
        pending_client_version,
        device_id
      )
      SELECT
        pairing_id,
        server_id,
        muximod_base_url,
        secret_hash,
        claim_token_hash,
        status,
        offered_at,
        expires_at,
        claim_expires_at,
        claimed_at,
        approved_at,
        pending_public_key_jwk,
        pending_fingerprint,
        pending_display_name,
        pending_device_type,
        pending_platform,
        pending_client_version,
        device_id
      FROM auth_pairings;
      DROP INDEX IF EXISTS auth_pairings_status_index;
      DROP TABLE auth_pairings;
      ALTER TABLE auth_pairings_without_web_origin RENAME TO auth_pairings;
      CREATE INDEX auth_pairings_status_index ON auth_pairings (status);
    `);
    sqlite.exec("COMMIT");
  } catch (error) {
    try {
      sqlite.exec("ROLLBACK");
    } catch {
      // Preserve the schema migration error if rollback itself fails.
    }
    throw new Error("auth_pairings schema migration failed", { cause: error });
  }
}
