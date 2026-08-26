import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, WorkspaceId, type WorkspaceRecord } from "@muximo/domain";
import {
  type FixtureHandle,
  hasError,
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
  DrizzleWorkspaceRepository,
  SqliteTransactionManager,
} from "./index.js";

type Input = {
  mode: "commit" | "rollback" | "nested" | "cross-database";
  id: string;
};

type Fixture = {
  database: ReturnType<typeof createAgentDatabase>;
  manager: SqliteTransactionManager;
  repository: DrizzleWorkspaceRepository;
  otherDatabase?: ReturnType<typeof createAgentDatabase>;
  otherManager?: SqliteTransactionManager;
  otherRepository?: DrizzleWorkspaceRepository;
};

type Context = {
  count: number;
  names: readonly string[];
};

const cases = [
  {
    name: "commits a database-only scope",
    input: { mode: "commit", id: "workspace-commit" },
    assert: [
      hasNoError<Context, number>(),
      hasObserved<Context, number>("count", 1),
      hasObserved<Context, number>("names", ["commit"]),
    ],
  },
  {
    name: "rolls back every write when the scope fails",
    input: { mode: "rollback", id: "workspace-rollback" },
    assert: [
      hasError<Context, number>({ message: "rollback requested" }),
      hasObserved<Context, number>("count", 0),
      hasObserved<Context, number>("names", []),
    ],
  },
  {
    name: "reuses the ambient scope for nested application transactions",
    input: { mode: "nested", id: "workspace-nested" },
    assert: [
      hasNoError<Context, number>(),
      hasObserved<Context, number>("count", 2),
      hasObserved<Context, number>("names", ["nested", "nested-child"]),
    ],
  },
  {
    name: "rejects a repository from a different ambient database",
    fixture: "two-database",
    input: { mode: "cross-database", id: "workspace-cross-database" },
    assert: [
      hasError<Context, number>({ message: "SQLite transaction database identity mismatch" }),
      hasObserved<Context, number>("count", 0),
      hasObserved<Context, number>("names", []),
    ],
  },
] satisfies readonly OperationCase<"default" | "two-database", Input, number, Context>[];

const table: OperationTable<Fixture, "default" | "two-database", Input, number, Context> = {
  defaultFixture: createFixture,
  fixtures: { default: createFixture, "two-database": createTwoDatabaseFixture },
  cases,
  execute: async (fixture, input) => {
    if (input.mode === "cross-database") {
      return fixture.manager.run(async () => {
        await fixture.otherRepository!.list();
        return 0;
      });
    }
    return fixture.manager.run(async () => {
      await fixture.repository.upsert(createWorkspace(input.id, input.mode === "nested" ? "nested" : "commit"));
      if (input.mode === "rollback") throw new Error("rollback requested");
      if (input.mode === "nested") {
        await fixture.manager.run(async () => {
          await fixture.repository.upsert(createWorkspace(`${input.id}-child`, "nested-child"));
        });
      }
      return (await fixture.repository.list()).length;
    });
  },
  observe: async (fixture) => {
    const records = await fixture.repository.list();
    return { count: records.length, names: records.map((record) => record.name) };
  },
};

describe("SQLite transaction manager", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFixture(): FixtureHandle<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "muximo-transaction-manager-"));
  const database = createAgentDatabase(join(root, "muximod.sqlite"), {
    schemaSynchronizer: createMigrationSchemaSynchronizer(),
  });
  const manager = new SqliteTransactionManager(database);
  const repository = new DrizzleWorkspaceRepository(database.db);
  return {
    fixture: { database, manager, repository },
    cleanup: () => {
      manager.close();
      database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function createTwoDatabaseFixture(): FixtureHandle<Fixture> {
  const firstRoot = mkdtempSync(join(tmpdir(), "muximo-transaction-first-"));
  const secondRoot = mkdtempSync(join(tmpdir(), "muximo-transaction-second-"));
  const database = createAgentDatabase(join(firstRoot, "muximod.sqlite"), {
    schemaSynchronizer: createMigrationSchemaSynchronizer(),
  });
  const otherDatabase = createAgentDatabase(join(secondRoot, "muximod.sqlite"), {
    schemaSynchronizer: createMigrationSchemaSynchronizer(),
  });
  const manager = new SqliteTransactionManager(database);
  const otherManager = new SqliteTransactionManager(otherDatabase);
  return {
    fixture: {
      database,
      manager,
      repository: new DrizzleWorkspaceRepository(database.db),
      otherDatabase,
      otherManager,
      otherRepository: new DrizzleWorkspaceRepository(otherDatabase.db),
    },
    cleanup: () => {
      manager.close();
      otherManager.close();
      database.close();
      otherDatabase.close();
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    },
  };
}

function createWorkspace(id: string, name: string): WorkspaceRecord {
  return Workspace.create({
    id: WorkspaceId.create(id),
    rootPath: `/tmp/${id}`,
    name,
    isGit: false,
    worktreeCopyPatterns: [],
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  });
}
