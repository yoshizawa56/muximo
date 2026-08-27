import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
import { type DevStateSnapshotter, ensureDevMuximodState } from "./dev-state.js";

type FixtureKey = "base" | "existing-target" | "missing-base" | "no-base" | "racing-target";
type Fixture = {
  root: string;
  environment: NodeJS.ProcessEnv;
  baseDatabase?: Database;
  baseDatabaseFile?: string;
  targetDatabase?: Database;
  snapshot?: DevStateSnapshotter;
};
type Input = { operation: "bootstrap" };
type Context = {
  targetExists: boolean;
  targetValue: string | undefined;
  baseValue: string | undefined;
  authTables: readonly string[];
  authSessionCount: number;
  authServerId: string | undefined;
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
    name: "snapshots the parent database into a missing worktree state",
    fixture: "base",
    input: { operation: "bootstrap" },
    assert: [
      hasNoError<Context, unknown>(),
      hasObserved<Context, unknown>("targetExists", true),
      hasObserved<Context, unknown>("targetValue", "from-base"),
      hasObserved<Context, unknown>("baseValue", "from-base"),
      hasObserved<Context, unknown>("authTables", []),
      hasObserved<Context, unknown>("authSessionCount", 0),
      hasObserved<Context, unknown>("authServerId", undefined),
    ],
  },
  {
    name: "keeps an existing worktree state instead of overwriting it",
    fixture: "existing-target",
    input: { operation: "bootstrap" },
    assert: [hasNoError<Context, unknown>(), hasObserved<Context, unknown>("targetValue", "from-target")],
  },
  {
    name: "keeps a target published while the snapshot is being prepared",
    fixture: "racing-target",
    input: { operation: "bootstrap" },
    assert: [hasNoError<Context, unknown>(), hasObserved<Context, unknown>("targetValue", "from-concurrent")],
  },
  {
    name: "reports a missing configured parent database",
    fixture: "missing-base",
    input: { operation: "bootstrap" },
    assert: [errorContains("reports the missing base", "base muximod database was not found")],
  },
  {
    name: "does nothing when no parent state is configured",
    fixture: "no-base",
    input: { operation: "bootstrap" },
    assert: [hasNoError<Context, unknown>(), hasObserved<Context, unknown>("targetExists", false)],
  },
] satisfies readonly OperationCase<FixtureKey, Input, unknown, Context>[];

const table: OperationTable<Fixture, FixtureKey, Input, unknown, Context> = {
  defaultFixture: () => createFixture("base"),
  fixtures: {
    base: () => createFixture("base"),
    "existing-target": () => createFixture("existing-target"),
    "missing-base": () => createFixture("missing-base"),
    "no-base": () => createFixture("no-base"),
    "racing-target": () => createFixture("racing-target"),
  },
  cases,
  execute: (fixture) => {
    ensureDevMuximodState(fixture.environment, fixture.snapshot);
  },
  observe: (fixture) => {
    const targetFile = join(fixture.environment.MUXIMOD_INSTANCE_DIR!, "muximod.sqlite");
    const targetExists = existsSync(targetFile);
    const targetValue = targetExists ? readValue(targetFile) : undefined;
    const authState = targetExists ? readAuthenticationState(targetFile) : emptyAuthenticationState;
    return {
      targetExists,
      targetValue,
      baseValue: fixture.baseDatabaseFile ? readValue(fixture.baseDatabaseFile) : undefined,
      ...authState,
    };
  },
};

describe("muximod development state bootstrap", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFixture(key: FixtureKey): { fixture: Fixture; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "muximod-dev-state-test-"));
  const baseDirectory = join(root, "base");
  const targetDirectory = join(root, "target");
  mkdirSync(baseDirectory, { recursive: true });
  mkdirSync(targetDirectory, { recursive: true });

  const environment: NodeJS.ProcessEnv = {
    HOME: root,
    MUXIMOD_INSTANCE_DIR: targetDirectory,
  };
  if (key !== "no-base") environment.BASE_MUXIMOD_INSTANCE_DIR = baseDirectory;

  let baseDatabase: Database | undefined;
  let baseDatabaseFile: string | undefined;
  if (key === "base" || key === "existing-target" || key === "racing-target") {
    baseDatabaseFile = join(baseDirectory, "muximod.sqlite");
    baseDatabase = openStateDatabase(baseDatabaseFile, "from-base");
    seedAuthenticationState(baseDatabase);
  }

  let targetDatabase: Database | undefined;
  if (key === "existing-target") {
    targetDatabase = openStateDatabase(join(targetDirectory, "muximod.sqlite"), "from-target");
  }

  const snapshot =
    key === "racing-target"
      ? (_sourceDatabaseFile: string, targetDatabaseFile: string) => {
          const snapshotDatabase = openStateDatabase(targetDatabaseFile, "from-snapshot");
          snapshotDatabase.close();
          targetDatabase = openStateDatabase(join(targetDirectory, "muximod.sqlite"), "from-concurrent");
        }
      : undefined;
  const fixture: Fixture = { root, environment, baseDatabase, baseDatabaseFile, targetDatabase, snapshot };
  return {
    fixture,
    cleanup: () => {
      targetDatabase?.close();
      baseDatabase?.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function openStateDatabase(file: string, value: string): Database {
  const database = new Database(file);
  database.exec("CREATE TABLE state (value TEXT NOT NULL)");
  database.query("INSERT INTO state (value) VALUES (?)").run(value);
  return database;
}

function readValue(file: string): string | undefined {
  const database = new Database(file, { readonly: true });
  try {
    return (database.query("SELECT value FROM state").get() as { value?: string } | null)?.value;
  } finally {
    database.close();
  }
}

const emptyAuthenticationState = {
  authTables: [] as readonly string[],
  authSessionCount: 0,
  authServerId: undefined as string | undefined,
};

function seedAuthenticationState(database: Database): void {
  database.exec(`
    CREATE TABLE auth_metadata (id INTEGER PRIMARY KEY, server_id TEXT NOT NULL);
    CREATE TABLE auth_devices (device_id TEXT PRIMARY KEY);
    CREATE TABLE auth_pairings (pairing_id TEXT PRIMARY KEY);
    CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY, token_hash TEXT NOT NULL);
    INSERT INTO auth_metadata (id, server_id) VALUES (1, 'server-from-base');
    INSERT INTO auth_sessions (session_id, token_hash) VALUES ('session-from-base', 'hash-from-base');
  `);
}

function readAuthenticationState(file: string): typeof emptyAuthenticationState {
  const database = new Database(file, { readonly: true });
  try {
    const authTables = (
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'auth_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    const authSessionCount = authTables.includes("auth_sessions")
      ? Number((database.query("SELECT COUNT(*) AS count FROM auth_sessions").get() as { count?: number }).count ?? 0)
      : 0;
    const authServerId = authTables.includes("auth_metadata")
      ? (
          database.query("SELECT server_id AS serverId FROM auth_metadata WHERE id = 1").get() as {
            serverId?: string;
          } | null
        )?.serverId
      : undefined;
    return { authTables, authSessionCount, authServerId };
  } finally {
    database.close();
  }
}
