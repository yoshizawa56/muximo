import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import {
  hasError,
  hasNoError,
  hasObserved,
  runOperationTable,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Workspace, WorkspaceId, type WorkspaceRecord } from "@muximo/domain";
import { createAgentDatabase, DrizzleWorkspaceRepository, SqliteTransactionManager } from "./index.js";

type Input = {
  mode: "commit" | "rollback" | "nested";
  id: string;
};

type Fixture = {
  database: ReturnType<typeof createAgentDatabase>;
  manager: SqliteTransactionManager;
  repository: DrizzleWorkspaceRepository;
};

type Context = {
  count: number;
  names: readonly string[];
};

const cases = [
  {
    name: "commits a database-only scope",
    input: { mode: "commit", id: "workspace-commit" },
    assert: [hasNoError<Context, number>(), hasObserved<Context, number>("count", 1), hasObserved<Context, number>("names", ["commit"])],
  },
  {
    name: "rolls back every write when the scope fails",
    input: { mode: "rollback", id: "workspace-rollback" },
    assert: [hasError<Context, number>({ message: "rollback requested" }), hasObserved<Context, number>("count", 0), hasObserved<Context, number>("names", [])],
  },
  {
    name: "reuses the ambient scope for nested application transactions",
    input: { mode: "nested", id: "workspace-nested" },
    assert: [hasNoError<Context, number>(), hasObserved<Context, number>("count", 2), hasObserved<Context, number>("names", ["nested", "nested-child"])],
  },
] satisfies readonly OperationCase<"default", Input, number, Context>[];

const table: OperationTable<Fixture, "default", Input, number, Context> = {
  defaultFixture: createFixture,
  cases,
  execute: async (fixture, input) => {
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
  const database = createAgentDatabase(join(root, "muximod.sqlite"));
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
