import { Database as BunDatabase } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Assertion,
  hasNoError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  createAgentDatabase,
  createMigrationSchemaSynchronizer,
  type DatabaseSchemaSynchronizer,
  type PushCommandOptions,
  PushSchemaSynchronizer,
} from "./index.js";

type FixtureKey = "migration" | "push" | "push-existing-receipt" | "push-memory";
type Input = { operation: "create-database" };
type PushCall = { command: string; args: readonly string[]; options: PushCommandOptions };
type Fixture = {
  root: string;
  calls: PushCall[];
  databases: Array<ReturnType<typeof createAgentDatabase>>;
  databaseFile: string;
  synchronizer: DatabaseSchemaSynchronizer;
};
type Context = {
  callCount: number;
  pushCommand: string | undefined;
  pushArgs: readonly string[];
  receiptTables: readonly string[];
  migrationTables: readonly string[];
  authTables: readonly string[];
};

const errorContains = <Result>(name: string, text: string): Assertion<Context, Result> => ({
  name,
  allowsOutcomeError: true,
  check: (_context, outcome) => {
    if (outcome.ok) throw new Error("expected the operation to fail");
    assert.match(outcome.error instanceof Error ? outcome.error.message : String(outcome.error), new RegExp(text));
  },
});

const cases = [
  {
    name: "runs the migration synchronizer through the required strategy boundary",
    fixture: "migration",
    input: { operation: "create-database" },
    assert: [
      hasNoError<Context, unknown>(),
      hasObserved<Context, unknown>("migrationTables", ["__drizzle_migrations"]),
      hasObserved<Context, unknown>("authTables", ["auth_devices", "auth_metadata", "auth_pairings", "auth_sessions"]),
    ],
  },
  {
    name: "runs push with the dev config and target database path",
    fixture: "push",
    input: { operation: "create-database" },
    assert: [
      hasNoError<Context, unknown>(),
      hasObserved<Context, unknown>("callCount", 1),
      hasObserved<Context, unknown>("pushCommand", "node"),
      hasObserved<Context, unknown>("pushArgs", [
        "/repo/packages/infrastructure/node_modules/drizzle-kit/bin.cjs",
        "push",
        "--config",
        "drizzle.dev.config.ts",
        "--force",
      ]),
    ],
  },
  {
    name: "rejects push for an in-memory database",
    fixture: "push-memory",
    input: { operation: "create-database" },
    assert: [errorContains("reports the file-backed requirement", "file-backed SQLite database")],
  },
  {
    name: "pushes a database with an existing execution receipt table",
    fixture: "push-existing-receipt",
    input: { operation: "create-database" },
    assert: [
      hasNoError<Context, unknown>(),
      hasObserved<Context, unknown>("receiptTables", ["agent_execution_receipts"]),
      hasObserved<Context, unknown>("migrationTables", []),
    ],
  },
] satisfies readonly OperationCase<FixtureKey, Input, unknown, Context>[];

const table: OperationTable<Fixture, FixtureKey, Input, unknown, Context> = {
  defaultFixture: () => createFixture("migration"),
  fixtures: {
    migration: () => createFixture("migration"),
    push: () => createFixture("push"),
    "push-existing-receipt": () => createFixture("push-existing-receipt"),
    "push-memory": () => createFixture("push-memory"),
  },
  cases,
  execute: (fixture) => {
    const database = createAgentDatabase(fixture.databaseFile, { schemaSynchronizer: fixture.synchronizer });
    fixture.databases.push(database);
    return database.databaseFile;
  },
  observe: (fixture) => {
    const database = fixture.databases[0];
    const tableNames = database
      ? (
          database.sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{
            name: string;
          }>
        ).map((row) => row.name)
      : [];
    return {
      callCount: fixture.calls.length,
      pushCommand: fixture.calls[0]?.command,
      pushArgs: fixture.calls[0]?.args ?? [],
      receiptTables: tableNames.filter((name) => name === "agent_execution_receipts"),
      migrationTables: tableNames.filter((name) => name === "__drizzle_migrations"),
      authTables: tableNames.filter((name) => name.startsWith("auth_")).sort(),
    };
  },
};

describe("database schema synchronization", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFixture(key: FixtureKey): { fixture: Fixture; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "muximo-schema-sync-test-"));
  const calls: PushCall[] = [];
  const infrastructureDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const workingDirectory =
    key === "push-existing-receipt" ? infrastructureDirectory : join("/repo", "packages/infrastructure");
  const databaseFile =
    key === "push" || key === "push-existing-receipt" ? join(root, "target", "muximod.sqlite") : ":memory:";
  const environment =
    key === "push-existing-receipt"
      ? {
          ...process.env,
          MUXIMOD_INSTANCE_DIR: join(root, "instance"),
          MUXIMOD_DB_FILE: undefined,
          MUXIMO_DATABASE_FILE: undefined,
        }
      : undefined;
  const pushOptions = {
    configFile: join(workingDirectory, "drizzle.dev.config.ts"),
    workingDirectory,
    environment,
    force: true,
  };
  const synchronizer =
    key === "migration"
      ? createMigrationSchemaSynchronizer()
      : new PushSchemaSynchronizer(
          key === "push-existing-receipt"
            ? pushOptions
            : { ...pushOptions, run: (command, args, options) => calls.push({ command, args, options }) },
        );
  const fixture: Fixture = { root, calls, databases: [], databaseFile, synchronizer };
  if (key === "push-existing-receipt") seedExecutionReceiptTable(databaseFile);
  return {
    fixture,
    cleanup: () => {
      for (const database of fixture.databases) database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function seedExecutionReceiptTable(databaseFile: string): void {
  mkdirSync(dirname(databaseFile), { recursive: true });
  const sqlite = new BunDatabase(databaseFile);
  sqlite.exec(`
    CREATE TABLE "agent_execution_receipts" (
      "execution_id" text PRIMARY KEY NOT NULL,
      "agent_session_id" text NOT NULL,
      "operation" text NOT NULL,
      "process" text NOT NULL,
      "session" text NOT NULL,
      "cleanup" text,
      "created_at" text NOT NULL,
      "updated_at" text NOT NULL
    )
  `);
  sqlite.close();
}
