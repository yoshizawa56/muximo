import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace, WorkspaceId } from "@muximo/domain";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  resolveMaybePromise,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { afterAll, describe, it } from "vitest";
import { createSqliteRollbackScope } from "./__tests__/sqlite-table-scope.js";
import { createAgentDatabase, createMigrationSchemaSynchronizer, DrizzleWorkspaceRepository } from "./index.js";

type Input = { id: string };
type Fixture = { repository: DrizzleWorkspaceRepository };
type Context = { count: number; names: readonly string[] };

const root = mkdtempSync(join(tmpdir(), "muximo-transaction-table-"));
const database = createAgentDatabase(join(root, "muximod.sqlite"), {
  schemaSynchronizer: createMigrationSchemaSynchronizer(),
});
const scope = createSqliteRollbackScope(database);
const repository = new DrizzleWorkspaceRepository(database.db);

const cases = [
  {
    name: "rolls back a successful database case after observation",
    input: { id: "workspace-scope-one" },
    assert: [hasObserved<Context, number>("count", 1), hasObserved<Context, number>("names", ["scope-one"])],
  },
  {
    name: "starts the next database case from the migrated baseline",
    input: { id: "workspace-scope-two" },
    assert: [hasObserved<Context, number>("count", 1), hasObserved<Context, number>("names", ["scope-two"])],
  },
] satisfies readonly OperationCase<"default", Input, number, Context>[];

const table: OperationTable<Fixture, "default", Input, number, Context> = {
  defaultFixture: () => ({ fixture: { repository } }),
  caseScope: scope.caseScope,
  cases,
  execute: async (fixture, input) => {
    await resolveMaybePromise(fixture.repository.upsert(createWorkspace(input.id)));
    return (await resolveMaybePromise(fixture.repository.list())).length;
  },
  observe: async (fixture) => {
    const records = await resolveMaybePromise(fixture.repository.list());
    return { count: records.length, names: records.map((record) => record.name) };
  },
};

describe("sqlite table transaction scope", () => {
  afterAll(() => {
    scope.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  runOperationTable(it as unknown as TestRegistrar, table);
});

function createWorkspace(id: string): Workspace {
  return Workspace.create({
    id: WorkspaceId.create(id),
    rootPath: `/tmp/${id}`,
    name: id.replace("workspace-", ""),
    isGit: false,
  });
}
