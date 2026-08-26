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
  type PushCommandOptions,
  PushSchemaSynchronizer,
} from "./index.js";

type Input = { mode: "migrate" | "push" | "push-memory" };
type PushCall = { command: string; args: readonly string[]; options: PushCommandOptions };
type Fixture = {
  root: string;
  calls: PushCall[];
  databases: Array<ReturnType<typeof createAgentDatabase>>;
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
    input: { mode: "migrate" },
    assert: [
      hasNoError<Context, unknown>(),
      hasObserved<Context, unknown>("migrationTables", ["__drizzle_migrations"]),
      hasObserved<Context, unknown>("authTables", ["auth_devices", "auth_metadata", "auth_pairings", "auth_sessions"]),
    ],
  },
  {
    name: "runs push with the dev config and target database path",
    input: { mode: "push" },
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
    input: { mode: "push-memory" },
    assert: [errorContains("reports the file-backed requirement", "file-backed SQLite database")],
  },
] satisfies readonly OperationCase<"default", Input, unknown, Context>[];

const table: OperationTable<Fixture, "default", Input, unknown, Context> = {
  defaultFixture: () => {
    const root = mkdtempSync(join(tmpdir(), "muximo-schema-sync-test-"));
    const fixture: Fixture = { root, calls: [], databases: [] };
    return {
      fixture,
      cleanup: () => {
        for (const database of fixture.databases) database.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
  cases,
  execute: (fixture, input) => {
    if (input.mode === "migrate") {
      const database = createAgentDatabase(":memory:", {
        schemaSynchronizer: createMigrationSchemaSynchronizer(),
      });
      fixture.databases.push(database);
      return database.databaseFile;
    }

    const synchronizer = new PushSchemaSynchronizer({
      configFile: join("/repo", "packages/infrastructure", "drizzle.dev.config.ts"),
      workingDirectory: join("/repo", "packages/infrastructure"),
      force: true,
      run: (command, args, options) => fixture.calls.push({ command, args, options }),
    });
    const databaseFile = input.mode === "push-memory" ? ":memory:" : join(fixture.root, "muximod.sqlite");
    const database = createAgentDatabase(databaseFile, { schemaSynchronizer: synchronizer });
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
