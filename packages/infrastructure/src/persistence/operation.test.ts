import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Operation, OperationId, type OperationRecord } from "@muximo/domain";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { afterAll, describe, it } from "vitest";
import { createSqliteRollbackScope } from "./__tests__/sqlite-table-scope.js";
import { createAgentDatabase, createMigrationSchemaSynchronizer, DrizzleOperationRepository } from "./index.js";

type Action = "round-trip" | "compare-and-set" | "idempotency" | "retention";
type Fixture = { action: Action; repository: DrizzleOperationRepository; context: Context };
type Context = {
  state: string | undefined;
  result: unknown;
  subject: unknown;
  firstInserted: boolean | undefined;
  secondInserted: boolean | undefined;
  activeIds: readonly string[];
  removed: number | undefined;
};

const root = mkdtempSync(join(tmpdir(), "muximo-operation-repository-"));
const database = createAgentDatabase(join(root, "muximod.sqlite"), {
  schemaSynchronizer: createMigrationSchemaSynchronizer(),
});
const scope = createSqliteRollbackScope(database);

const cases = [
  {
    name: "round-trips operation metadata and structured result through SQLite",
    fixture: "round-trip" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "succeeded"),
      hasObserved<Context, unknown>("result", { answer: 42 }),
      hasObserved<Context, unknown>("subject", {
        type: "agent_session",
        id: "session-id",
        executionId: "execution-id",
      }),
    ],
  },
  {
    name: "rejects a stale compare-and-set update without changing the operation",
    fixture: "compare-and-set" as const,
    input: undefined,
    assert: [hasObserved<Context, unknown>("firstInserted", false), hasObserved<Context, unknown>("state", "running")],
  },
  {
    name: "enforces one idempotency key per operation kind",
    fixture: "idempotency" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("firstInserted", true),
      hasObserved<Context, unknown>("secondInserted", false),
    ],
  },
  {
    name: "deletes expired terminal operations while retaining active operations",
    fixture: "retention" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("removed", 1),
      hasObserved<Context, unknown>("activeIds", ["active-operation-id"]),
    ],
  },
] satisfies readonly OperationCase<Action, undefined, unknown, Context>[];

const table: OperationTable<Fixture, Action, undefined, unknown, Context> = {
  defaultFixture: () => createFixture("round-trip"),
  fixtures: {
    "round-trip": () => createFixture("round-trip"),
    "compare-and-set": () => createFixture("compare-and-set"),
    idempotency: () => createFixture("idempotency"),
    retention: () => createFixture("retention"),
  },
  caseScope: scope.caseScope,
  cases,
  execute: async (fixture) => {
    if (fixture.action === "round-trip") {
      let operation = Operation.create({
        id: OperationId.create("round-trip-operation-id"),
        kind: "agent_session.run",
        executor: "client",
        requestFingerprint: JSON.stringify({ operation: "run" }),
        idempotencyKey: "run-key",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      });
      await fixture.repository.insertIfAbsent(operation);
      operation = Operation.start(operation, "2026-08-20T00:00:01.000Z", {
        type: "agent_session",
        id: "session-id",
        executionId: "execution-id",
      });
      await fixture.repository.update(operation, "2026-08-20T00:00:00.000Z");
      operation = Operation.succeed(operation, "2026-08-20T00:00:02.000Z", { answer: 42 });
      await fixture.repository.update(operation, "2026-08-20T00:00:01.000Z");
      const stored = await fixture.repository.findById(operation.id);
      fixture.context.state = stored?.state;
      fixture.context.result = stored?.result;
      fixture.context.subject = stored?.subject;
      return stored;
    }
    if (fixture.action === "compare-and-set") {
      const operation = createRunningOperation("compare-and-set-operation-id");
      await fixture.repository.insertIfAbsent(operation);
      const next = Operation.succeed(operation, "2026-08-20T00:00:02.000Z", { answer: 42 });
      fixture.context.firstInserted = await fixture.repository.update(next, "stale-timestamp");
      fixture.context.state = (await fixture.repository.findById(operation.id))?.state;
      return next;
    }
    if (fixture.action === "idempotency") {
      const first = createRunningOperation("first-operation-id", "shared-key");
      const second = createRunningOperation("second-operation-id", "shared-key");
      fixture.context.firstInserted = await fixture.repository.insertIfAbsent(first);
      fixture.context.secondInserted = await fixture.repository.insertIfAbsent(second);
      return undefined;
    }
    const expired = Operation.succeed(createRunningOperation("expired-operation-id"), "2026-08-19T00:00:00.000Z", {});
    await fixture.repository.insertIfAbsent(expired);
    await fixture.repository.insertIfAbsent(createRunningOperation("active-operation-id"));
    fixture.context.removed = await fixture.repository.deleteCompletedBefore("2026-08-20T00:00:00.000Z");
    fixture.context.activeIds = (await fixture.repository.listActive()).map((operation) => operation.id);
    return fixture.context.removed;
  },
  observe: (fixture) => fixture.context,
};

describe("sqlite operation repository", () => {
  afterAll(() => {
    scope.close();
    database.close();
    rmSync(root, { recursive: true, force: true });
  });

  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFixture(action: Action): { fixture: Fixture } {
  return {
    fixture: {
      action,
      repository: new DrizzleOperationRepository(database.db),
      context: {
        state: undefined,
        result: undefined,
        subject: undefined,
        firstInserted: undefined,
        secondInserted: undefined,
        activeIds: [],
        removed: undefined,
      },
    },
  };
}

function createRunningOperation(id: string, idempotencyKey?: string): OperationRecord {
  const operation = Operation.create({
    id: OperationId.create(id),
    kind: "agent_session.cleanup",
    executor: "daemon",
    requestFingerprint: JSON.stringify({ id }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  });
  return Operation.start(operation, "2026-08-19T00:00:01.000Z");
}
