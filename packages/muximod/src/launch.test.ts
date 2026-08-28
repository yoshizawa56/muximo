import { Database } from "bun:sqlite";
import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  hasError,
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  ensureMuximodSnapshot,
  type MuximodLaunchOptions,
  muximodConfigurationFingerprint,
  parseMuximodBootstrap,
  readMuximodBootstrap,
  snapshotSqliteDatabase,
} from "./launch.js";

type SnapshotInput =
  | "copy"
  | "preserve-existing"
  | "missing-source"
  | "same-instance"
  | "concurrent-copy"
  | "reclaim-stale-lock"
  | "reclaim-expired-live-lock";
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
  snapshotCount: number;
};
type SnapshotFixture = {
  root: string;
  baseInstanceDir: string;
  targetInstanceDir: string;
  sourceDatabaseFile: string;
  targetDatabaseFile: string;
  snapshotCount: number;
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
    name: "serializes concurrent snapshot requests for one target instance",
    input: "concurrent-copy" as const,
    assert: [
      hasObserved<SnapshotContext, void>("targetExists", true),
      hasObserved<SnapshotContext, void>("snapshotCount", 1),
    ],
  },
  {
    name: "reclaims a bootstrap lock left by a crashed process",
    input: "reclaim-stale-lock" as const,
    assert: [
      hasObserved<SnapshotContext, void>("targetExists", true),
      hasObserved<SnapshotContext, void>("snapshotCount", 1),
    ],
  },
  {
    name: "reclaims an expired bootstrap lock even when its PID was reused",
    input: "reclaim-expired-live-lock" as const,
    assert: [
      hasObserved<SnapshotContext, void>("targetExists", true),
      hasObserved<SnapshotContext, void>("snapshotCount", 1),
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
  execute: async (fixture, input) => {
    if (input === "preserve-existing") createTargetDatabase(fixture.targetDatabaseFile);
    if (input === "missing-source") unlinkSync(fixture.sourceDatabaseFile);

    if (input === "concurrent-copy") {
      await Promise.all(
        [1, 2].map(() =>
          ensureMuximodSnapshot({
            baseInstanceDir: fixture.baseInstanceDir,
            targetInstanceDir: fixture.targetInstanceDir,
            targetDatabaseFile: fixture.targetDatabaseFile,
            snapshot: async (source, target) => {
              fixture.snapshotCount += 1;
              await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 25));
              snapshotSqliteDatabase(source, target);
            },
          }),
        ),
      );
      return;
    }

    if (input === "reclaim-stale-lock") {
      mkdirSync(fixture.targetInstanceDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        join(fixture.targetInstanceDir, "muximod.sqlite.bootstrap.lock"),
        JSON.stringify({
          pid: Number.MAX_SAFE_INTEGER,
          acquiredAt: "2026-08-28T00:00:00.000Z",
          token: "crashed-process-token",
        }),
        { mode: 0o600 },
      );
      await ensureMuximodSnapshot({
        baseInstanceDir: fixture.baseInstanceDir,
        targetInstanceDir: fixture.targetInstanceDir,
        targetDatabaseFile: fixture.targetDatabaseFile,
        snapshot: (source, target) => {
          fixture.snapshotCount += 1;
          snapshotSqliteDatabase(source, target);
        },
      });
      return;
    }

    if (input === "reclaim-expired-live-lock") {
      const lockFile = join(fixture.targetInstanceDir, "muximod.sqlite.bootstrap.lock");
      mkdirSync(fixture.targetInstanceDir, { recursive: true, mode: 0o700 });
      writeFileSync(
        lockFile,
        JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString(), token: "expired-process-token" }),
        { mode: 0o600 },
      );
      const expiredAt = new Date(Date.now() - 20_000);
      utimesSync(lockFile, expiredAt, expiredAt);
      await ensureMuximodSnapshot({
        baseInstanceDir: fixture.baseInstanceDir,
        targetInstanceDir: fixture.targetInstanceDir,
        targetDatabaseFile: fixture.targetDatabaseFile,
        snapshot: (source, target) => {
          fixture.snapshotCount += 1;
          snapshotSqliteDatabase(source, target);
        },
      });
      return;
    }

    const targetInstanceDir = input === "same-instance" ? fixture.baseInstanceDir : fixture.targetInstanceDir;
    await ensureMuximodSnapshot({
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
    fixture: { root, baseInstanceDir, targetInstanceDir, sourceDatabaseFile, targetDatabaseFile, snapshotCount: 0 },
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
    return {
      targetExists,
      tables: [],
      metadata: [],
      devices: [],
      pairings: [],
      sessions: [],
      application: [],
      snapshotCount: fixture.snapshotCount,
    };
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
      snapshotCount: fixture.snapshotCount,
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

const bootstrapOptions: MuximodLaunchOptions = {
  schemaMode: "migrate",
  config: {
    host: "127.0.0.1",
    port: 4317,
    instanceDirectory: "/tmp/muximod-instance",
    hookOutputDirectory: "/tmp/muximod-instance/hooks",
    pidFile: "/tmp/muximod-instance/muximod.pid",
    controlSocket: "/tmp/muximod-instance/muximod.sock",
    muximodBaseUrl: "http://127.0.0.1:4317",
    allowedOrigins: [],
    allowedRoots: ["/tmp"],
    logLevel: "info",
    workingDirectory: "/tmp",
    runtimeEnvironment: {
      homeDirectory: null,
      path: null,
      codexHome: null,
      claudeConfigDirectory: null,
      tailscaleBinary: null,
      tmuxPane: null,
      tmuxSocket: null,
      worktreeId: null,
      worktreeRoot: null,
      muximoCommand: null,
      codexRemote: "unix://",
      codexBinary: null,
      claudeBinary: null,
      opencodeBinary: null,
      migrationsDirectory: null,
    },
  },
};

type BootstrapReadFixture = { path: string };
const bootstrapReadCases = [
  {
    name: "reads a validated launch configuration from the private descriptor",
    input: undefined,
    assert: [returns<{}, MuximodLaunchOptions>(bootstrapOptions)],
  },
] satisfies readonly OperationCase<"default", undefined, MuximodLaunchOptions, {}>[];

const bootstrapReadTable: OperationTable<BootstrapReadFixture, "default", undefined, MuximodLaunchOptions, {}> = {
  defaultFixture: () => {
    const root = mkdtempSync(join(tmpdir(), "muximod-bootstrap-test-"));
    const path = join(root, "options.json");
    writeFileSync(path, JSON.stringify(bootstrapOptions), { mode: 0o600 });
    return { fixture: { path }, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  },
  cases: bootstrapReadCases,
  execute: (fixture) => readMuximodBootstrap(openSync(fixture.path, "r")),
  observe: () => ({}),
};

const bootstrapSizeCases = [
  {
    name: "rejects a bootstrap payload above the process boundary limit",
    input: "oversized" as const,
    assert: [hasError<{}, MuximodLaunchOptions>({ message: /payload exceeds/ })],
  },
] satisfies readonly OperationCase<"default", "oversized", MuximodLaunchOptions, {}>[];

const bootstrapSizeTable: OperationTable<undefined, "default", "oversized", MuximodLaunchOptions, {}> = {
  defaultFixture: noFixture(),
  cases: bootstrapSizeCases,
  execute: () => parseMuximodBootstrap("x".repeat(1024 * 1024 + 1)),
  observe: () => ({}),
};

describe("muximod process bootstrap", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, bootstrapReadTable);
  runOperationTable(register, bootstrapSizeTable);
});

type FingerprintInput = "same" | "different-origin" | "different-runtime" | "different-schema-mode";
type FingerprintResult = { first: string; second: string };
type FingerprintContext = { equal: boolean; length: number };

const fingerprintCases = [
  {
    name: "keeps identical launch configurations reusable",
    input: "same" as const,
    assert: [
      hasObserved<FingerprintContext, FingerprintResult>("equal", true),
      hasObserved<FingerprintContext, FingerprintResult>("length", 64),
    ],
  },
  {
    name: "changes when a browser origin changes",
    input: "different-origin" as const,
    assert: [hasObserved<FingerprintContext, FingerprintResult>("equal", false)],
  },
  {
    name: "changes when schema mode changes",
    input: "different-schema-mode" as const,
    assert: [hasObserved<FingerprintContext, FingerprintResult>("equal", false)],
  },
  {
    name: "changes when a daemon runtime environment value changes",
    input: "different-runtime" as const,
    assert: [hasObserved<FingerprintContext, FingerprintResult>("equal", false)],
  },
] satisfies readonly OperationCase<"default", FingerprintInput, FingerprintResult, FingerprintContext>[];

const fingerprintTable: OperationTable<undefined, "default", FingerprintInput, FingerprintResult, FingerprintContext> =
  {
    defaultFixture: noFixture(),
    cases: fingerprintCases,
    execute: (_fixture, input) => {
      const first = muximodConfigurationFingerprint(bootstrapOptions);
      const secondOptions =
        input === "same"
          ? bootstrapOptions
          : input === "different-origin"
            ? {
                ...bootstrapOptions,
                config: { ...bootstrapOptions.config, allowedOrigins: ["http://web.example"] },
              }
            : input === "different-runtime"
              ? {
                  ...bootstrapOptions,
                  config: {
                    ...bootstrapOptions.config,
                    runtimeEnvironment: { ...bootstrapOptions.config.runtimeEnvironment, codexRemote: "https://codex" },
                  },
                }
              : {
                  schemaMode: "push" as const,
                  baseInstanceDir: "/tmp/muximod-base",
                  config: bootstrapOptions.config,
                };
      const second = muximodConfigurationFingerprint(secondOptions);
      return { first, second };
    },
    observe: (_fixture, result) => {
      if (!result.ok) return { equal: false, length: 0 };
      return { equal: result.value.first === result.value.second, length: result.value.first.length };
    },
  };

describe("muximod configuration identity", () => {
  runOperationTable(it as unknown as TestRegistrar, fingerprintTable);
});
