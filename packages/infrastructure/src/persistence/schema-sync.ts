import type { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { AgentDrizzleDatabase } from "./database-types.js";

export type DatabaseSchemaSynchronizerInput = {
  databaseFile: string;
  db: AgentDrizzleDatabase;
  sqlite: Database;
  migrationsFolder?: string;
};

export interface DatabaseSchemaSynchronizer {
  synchronize(input: DatabaseSchemaSynchronizerInput): void;
}

export class MigrationSchemaSynchronizer implements DatabaseSchemaSynchronizer {
  public synchronize(input: DatabaseSchemaSynchronizerInput): void {
    const migrationsFolder = input.migrationsFolder;
    if (!migrationsFolder) throw new Error("migration schema synchronization requires a migrations folder");

    baselineLegacyDatabase(input.sqlite, migrationsFolder);
    migrate(input.db, { migrationsFolder });
  }
}

export function createMigrationSchemaSynchronizer(): DatabaseSchemaSynchronizer {
  return new MigrationSchemaSynchronizer();
}

export type PushCommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export type PushCommandRunner = (command: string, args: readonly string[], options: PushCommandOptions) => void;

export type PushSchemaSynchronizerOptions = {
  configFile?: string;
  environment?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  force?: boolean;
  run?: PushCommandRunner;
};

const infrastructureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export class PushSchemaSynchronizer implements DatabaseSchemaSynchronizer {
  private readonly configFile: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly workingDirectory: string;
  private readonly force: boolean;
  private readonly run: PushCommandRunner;

  public constructor(options: PushSchemaSynchronizerOptions = {}) {
    this.configFile = resolve(options.configFile ?? resolve(infrastructureDirectory, "drizzle.dev.config.ts"));
    this.environment = options.environment ?? process.env;
    this.workingDirectory = resolve(options.workingDirectory ?? infrastructureDirectory);
    this.force = options.force ?? false;
    this.run = options.run ?? runPushCommand;
  }

  public synchronize(input: DatabaseSchemaSynchronizerInput): void {
    if (input.databaseFile === ":memory:") {
      throw new Error("push schema synchronization requires a file-backed SQLite database");
    }

    const args = [
      join(this.workingDirectory, "node_modules/drizzle-kit/bin.cjs"),
      "push",
      "--config",
      relative(this.workingDirectory, this.configFile),
      ...(this.force ? ["--force"] : []),
    ];
    const environment = {
      ...this.environment,
      MUXIMOD_DATABASE_FILE: input.databaseFile,
    };

    try {
      this.run("node", args, { cwd: this.workingDirectory, env: environment });
    } catch (error) {
      throw new Error(`database schema push failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
}

export function createPushSchemaSynchronizer(options: PushSchemaSynchronizerOptions = {}): DatabaseSchemaSynchronizer {
  return new PushSchemaSynchronizer(options);
}

function runPushCommand(command: string, args: readonly string[], options: PushCommandOptions): void {
  execFileSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "inherit",
  });
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

function ensureColumn(sqlite: Database, table: string, column: string, definition: string): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === column))
    sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
