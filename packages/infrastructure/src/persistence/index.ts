import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { AgentDrizzleDatabase } from "./database-types.js";
import { embeddedMigrationFiles } from "./embedded-migrations.generated.js";
import { resolveMuximodPaths } from "./paths.js";
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
export type { MuximodInstancePaths, MuximodPathOverrides } from "./paths.js";
export {
  defaultMuximodInstanceDirectory,
  muximodControlSocketMaxBytes,
  resolveMuximodPaths,
  validateMuximodControlSocketPath,
} from "./paths.js";
export { AuthStore } from "./repositories/sqlite/auth.js";
export {
  DrizzleAgentSessionRepository,
  DrizzlePaneRepository,
  DrizzleRepositoryBase,
  DrizzleWorkspaceRepository,
  recordAuditEvent,
} from "./repositories/sqlite/index.js";
export { agentSessions, auditEvents, codexSessionStates, panes, workspaces } from "./schema.js";
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
  migrationsFolder?: string;
  instanceDirectory?: string;
  busyTimeoutMs?: number;
};

export function defaultAgentDatabaseFile(env: NodeJS.ProcessEnv = process.env): string {
  return resolveMuximodPaths(env).databaseFile;
}

export function createAgentDatabase(
  file: string | undefined = undefined,
  options: AgentDatabaseOptions = {},
): AgentDatabase {
  const databaseFile = file ?? defaultCreateDatabaseFile(process.env);
  const databasePath = databaseFile === ":memory:" ? databaseFile : resolve(databaseFile);
  const configuredInstanceDirectory =
    file === undefined && process.env.MUXIMOD_INSTANCE_DIR?.trim()
      ? resolveMuximodPaths(process.env).instanceDirectory
      : undefined;
  const instanceDirectory = options.instanceDirectory ?? configuredInstanceDirectory;
  if (databasePath !== ":memory:") {
    if (instanceDirectory) {
      const resolvedInstanceDirectory = resolve(instanceDirectory);
      mkdirSync(resolvedInstanceDirectory, { recursive: true, mode: 0o700 });
      chmodSync(resolvedInstanceDirectory, 0o700);
    }
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? defaultSqliteBusyTimeoutMs;
  const sqlite = openConfiguredConnection(databasePath, busyTimeoutMs);
  secureDatabaseFiles(databasePath);
  const migrationsFolder = options.migrationsFolder ?? findAgentMigrationsFolder() ?? materializeEmbeddedMigrations();
  baselineLegacyDatabase(sqlite, migrationsFolder);
  const db = drizzle({ client: sqlite });
  try {
    migrate(db, { migrationsFolder });
  } catch (error) {
    sqlite.close();
    throw new Error(`database migration failed: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
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

function defaultCreateDatabaseFile(env: NodeJS.ProcessEnv): string {
  const configured = [env.MUXIMOD_INSTANCE_DIR, env.MUXIMOD_DB_FILE, env.MUXIMO_DATABASE_FILE].some((value) =>
    Boolean(value?.trim()),
  );
  if (!configured) return ":memory:";
  return resolveMuximodPaths(env).databaseFile;
}

export function defaultAgentMigrationsFolder(env: NodeJS.ProcessEnv = process.env): string {
  const folder = findAgentMigrationsFolder(env);
  if (!folder) {
    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const executableDirectory = dirname(process.execPath);
    throw new Error(
      `database migration files not found; set MUXIMOD_MIGRATIONS_DIR (searched: ${[
        env.MUXIMOD_MIGRATIONS_DIR ? resolve(process.cwd(), env.MUXIMOD_MIGRATIONS_DIR) : undefined,
        env.MUXIMO_MIGRATIONS_DIR ? resolve(process.cwd(), env.MUXIMO_MIGRATIONS_DIR) : undefined,
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
  const configured = env.MUXIMOD_MIGRATIONS_DIR ?? env.MUXIMO_MIGRATIONS_DIR;
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

const legacyTableNames = ["panes", "runs", "audit_events", "workspaces", "agent_sessions"] as const;

// Raw SQL is restricted to legacy migration baselining; repository CRUD stays in Drizzle adapters.
function baselineLegacyDatabase(sqlite: Database, migrationsFolder: string): void {
  const migrations = readMigrationFiles({ migrationsFolder });
  const initialMigration = migrations[0];
  if (!initialMigration) throw new Error(`no migrations found in ${migrationsFolder}`);

  const rows = sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
  const existingTables = new Set(rows.map((row) => row.name));
  if (existingTables.has("__drizzle_migrations")) return;

  const legacyTables = legacyTableNames.filter((tableName) => existingTables.has(tableName));
  if (legacyTables.length === 0) return;
  if (legacyTables.length !== legacyTableNames.length) {
    throw new Error(`database has a partial legacy schema; refusing to baseline (${legacyTables.join(", ")})`);
  }

  ensureColumn(sqlite, "workspaces", "setup_script_path", "TEXT");
  ensureColumn(sqlite, "workspaces", "cleanup_script_path", "TEXT");
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at numeric
    )
  `);
  sqlite
    .prepare('INSERT INTO "__drizzle_migrations" ("hash", "created_at") VALUES (?, ?)')
    .run(initialMigration.hash, initialMigration.folderMillis);
}

// Auth tables are bootstrapped for legacy databases here; AuthStore CRUD uses auth-schema.ts through Drizzle.
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
}

function ensureColumn(sqlite: Database, table: string, column: string, definition: string): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column))
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
