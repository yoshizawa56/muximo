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
import { ensureDevMuximodState } from "./dev-state.js";

type FixtureKey = "base" | "existing-target" | "missing-base" | "no-base";
type Fixture = {
  root: string;
  environment: NodeJS.ProcessEnv;
  baseDatabase?: Database;
  baseDatabaseFile?: string;
  targetDatabase?: Database;
};
type Input = { operation: "bootstrap" };
type Context = {
  targetExists: boolean;
  targetValue: string | undefined;
  baseValue: string | undefined;
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
    ],
  },
  {
    name: "keeps an existing worktree state instead of overwriting it",
    fixture: "existing-target",
    input: { operation: "bootstrap" },
    assert: [hasNoError<Context, unknown>(), hasObserved<Context, unknown>("targetValue", "from-target")],
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
  },
  cases,
  execute: (fixture) => {
    ensureDevMuximodState(fixture.environment);
  },
  observe: (fixture) => {
    const targetFile = join(fixture.environment.MUXIMOD_INSTANCE_DIR!, "muximod.sqlite");
    const targetExists = existsSync(targetFile);
    const targetValue = targetExists ? readValue(targetFile) : undefined;
    return {
      targetExists,
      targetValue,
      baseValue: fixture.baseDatabaseFile ? readValue(fixture.baseDatabaseFile) : undefined,
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
  if (key === "base" || key === "existing-target") {
    baseDatabaseFile = join(baseDirectory, "muximod.sqlite");
    baseDatabase = openStateDatabase(baseDatabaseFile, "from-base");
  }

  let targetDatabase: Database | undefined;
  if (key === "existing-target") {
    targetDatabase = openStateDatabase(join(targetDirectory, "muximod.sqlite"), "from-target");
  }

  const fixture: Fixture = { root, environment, baseDatabase, baseDatabaseFile, targetDatabase };
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
