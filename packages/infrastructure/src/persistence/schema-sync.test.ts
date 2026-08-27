import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type FixtureKey = "migration" | "push" | "push-memory";
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
] satisfies readonly OperationCase<FixtureKey, Input, unknown, Context>[];

const table: OperationTable<Fixture, FixtureKey, Input, unknown, Context> = {
  defaultFixture: () => createFixture("migration"),
  fixtures: {
    migration: () => createFixture("migration"),
    push: () => createFixture("push"),
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
  const workingDirectory = join("/repo", "packages/infrastructure");
  const synchronizer =
    key === "migration"
      ? createMigrationSchemaSynchronizer()
      : new PushSchemaSynchronizer({
          configFile: join(workingDirectory, "drizzle.dev.config.ts"),
          workingDirectory,
          force: true,
          run: (command, args, options) => calls.push({ command, args, options }),
        });
  const databaseFile = key === "push" ? join(root, "muximod.sqlite") : ":memory:";
  const fixture: Fixture = { root, calls, databases: [], databaseFile, synchronizer };
  return {
    fixture,
    cleanup: () => {
      for (const database of fixture.databases) database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
