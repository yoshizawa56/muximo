import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { ensureMuximodSnapshot } from "./launch.js";

type SnapshotInput = "copy" | "preserve-existing" | "missing-source" | "same-instance";
type SnapshotRow = { id: number; value: string };
type SnapshotContext = {
  targetExists: boolean;
  targetMode?: number;
  tables: string[];
  metadata: SnapshotRow[];
  devices: SnapshotRow[];
  pairings: SnapshotRow[];
  sessions: SnapshotRow[];
  application: SnapshotRow[];
};
type SnapshotFixture = {
  root: string;
  baseInstanceDir: string;
  targetInstanceDir: string;
  sourceDatabaseFile: string;
  targetDatabaseFile: string;
};

const cases = [
  {
    name: "copies every table and preserves the authentication realm metadata",
    input: "copy" as const,
    assert: [
      hasObserved<SnapshotContext, void>("targetExists", true),
      hasObserved<SnapshotContext, void>("tables", [
        "application_state",
        "auth_devices",
        "auth_metadata",
        "auth_pairings",
        "auth_sessions",
      ]),
      hasObserved<SnapshotContext, void>("metadata", [{ id: 1, value: "server-id-from-base" }]),
      hasObserved<SnapshotContext, void>("devices", [{ id: 1, value: "device-from-base" }]),
      hasObserved<SnapshotContext, void>("pairings", [{ id: 1, value: "pairing-from-base" }]),
      hasObserved<SnapshotContext, void>("sessions", [{ id: 1, value: "session-from-base" }]),
      hasObserved<SnapshotContext, void>("application", [{ id: 1, value: "session-state-from-base" }]),
      {
        name: "publishes the snapshot with a private file mode",
        check: (context: SnapshotContext) => assert.equal(context.targetMode, 0o600),
      },
    ],
  },
  {
    name: "does not overwrite an existing target database",
    input: "preserve-existing" as const,
    assert: [
      hasObserved<SnapshotContext, void>("metadata", [{ id: 1, value: "target-state" }]),
      hasObserved<SnapshotContext, void>("devices", []),
      hasObserved<SnapshotContext, void>("application", []),
    ],
  },
  {
    name: "fails clearly when the base database is missing",
    input: "missing-source" as const,
    assert: [hasError<SnapshotContext, void>({ message: /base muximod database was not found/ })],
  },
  {
    name: "rejects a snapshot into the same muximod instance",
    input: "same-instance" as const,
    assert: [hasError<SnapshotContext, void>({ message: "base and target muximod instances must be different" })],
  },
] satisfies readonly OperationCase<"default", SnapshotInput, void, SnapshotContext>[];

const table: OperationTable<SnapshotFixture, "default", SnapshotInput, void, SnapshotContext> = {
  defaultFixture: () => createFixture(),
  cases,
  execute: (fixture, input) => {
    if (input === "preserve-existing") createTargetDatabase(fixture.targetDatabaseFile);
    if (input === "missing-source") unlinkSync(fixture.sourceDatabaseFile);

    const targetInstanceDir = input === "same-instance" ? fixture.baseInstanceDir : fixture.targetInstanceDir;
    ensureMuximodSnapshot({
      baseInstanceDir: fixture.baseInstanceDir,
      targetInstanceDir,
      targetDatabaseFile:
        input === "same-instance" ? join(targetInstanceDir, "new.sqlite") : fixture.targetDatabaseFile,
    });
  },
  observe: (fixture) => readContext(fixture),
};

function createFixture(): { fixture: SnapshotFixture; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "muximo-snapshot-test-"));
  const baseInstanceDir = join(root, "base");
  const targetInstanceDir = join(root, "target");
  mkdirSync(baseInstanceDir, { recursive: true, mode: 0o700 });
  const sourceDatabaseFile = join(baseInstanceDir, "muximod.sqlite");
  const targetDatabaseFile = join(targetInstanceDir, "muximod.sqlite");
  createDatabase(sourceDatabaseFile, "session-state-from-base");
  return {
    fixture: { root, baseInstanceDir, targetInstanceDir, sourceDatabaseFile, targetDatabaseFile },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function createDatabase(path: string, applicationValue: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path);
  try {
    database.exec(`
      PRAGMA user_version = 7;
      CREATE TABLE auth_metadata (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE auth_devices (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE auth_pairings (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE auth_sessions (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE application_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO auth_metadata VALUES (1, 'server-id-from-base');
      INSERT INTO auth_devices VALUES (1, 'device-from-base');
      INSERT INTO auth_pairings VALUES (1, 'pairing-from-base');
      INSERT INTO auth_sessions VALUES (1, 'session-from-base');
      INSERT INTO application_state VALUES (1, '${applicationValue.replaceAll("'", "''")}');
    `);
  } finally {
    database.close();
  }
}

function readContext(fixture: SnapshotFixture): SnapshotContext {
  const targetExists = existsSync(fixture.targetDatabaseFile);
  if (!targetExists) {
    return { targetExists, tables: [], metadata: [], devices: [], pairings: [], sessions: [], application: [] };
  }

  const database = new Database(fixture.targetDatabaseFile, { readonly: true });
  try {
    const tables = (
      database
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    return {
      targetExists,
      targetMode: statSync(fixture.targetDatabaseFile).mode & 0o777,
      tables,
      metadata: readRows(database, tables, "auth_metadata"),
      devices: readRows(database, tables, "auth_devices"),
      pairings: readRows(database, tables, "auth_pairings"),
      sessions: readRows(database, tables, "auth_sessions"),
      application: readRows(database, tables, "application_state"),
    };
  } finally {
    database.close();
  }
}

function readRows(database: Database, tables: readonly string[], table: string): SnapshotRow[] {
  if (!tables.includes(table)) return [];
  return database.query(`SELECT id, value FROM "${table}" ORDER BY id`).all() as SnapshotRow[];
}

function createTargetDatabase(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const database = new Database(path);
  try {
    database.exec(
      "CREATE TABLE auth_metadata (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO auth_metadata VALUES (1, 'target-state');",
    );
  } finally {
    database.close();
  }
}

describe("muximod launch snapshot", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
});
