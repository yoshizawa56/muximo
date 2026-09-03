import { Operation, OperationId, type OperationRecord, type OperationState } from "@muximo/domain";
import {
  type FixtureHandle,
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { OperationRepository } from "../../ports/operations.js";
import { OperationService } from "./operation-service.js";

type Action = "create" | "existing" | "conflict" | "cancel" | "recover" | "retention";
type Fixture = {
  action: Action;
  repository: MemoryOperationRepository;
  service: OperationService;
  controller?: AbortController;
  result?: unknown;
};
type Context = {
  state: OperationState | undefined;
  errorCode: string | undefined;
  created: boolean | undefined;
  operationId: string | undefined;
  aborted: boolean;
  removed: number | undefined;
};

const operationCases = [
  {
    name: "allocates a queued operation before execution starts",
    fixture: "create" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "queued"),
      hasObserved<Context, unknown>("created", true),
      hasObserved<Context, unknown>("errorCode", undefined),
    ],
  },
  {
    name: "returns the existing operation for an equivalent idempotent request",
    fixture: "existing" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("created", false),
      hasObserved<Context, unknown>("operationId", "existing-operation-id"),
      hasObserved<Context, unknown>("state", "running"),
    ],
  },
  {
    name: "rejects an idempotency key reused for a different request",
    fixture: "conflict" as const,
    input: undefined,
    assert: [hasError<Context, unknown>({ code: "operation_idempotency_conflict" })],
  },
  {
    name: "records cancellation intent and aborts the active executor",
    fixture: "cancel" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "running"),
      hasObserved<Context, unknown>("errorCode", undefined),
      hasObserved<Context, unknown>("aborted", true),
    ],
  },
  {
    name: "fails daemon-owned work after a restart",
    fixture: "recover" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "failed"),
      hasObserved<Context, unknown>("errorCode", "muximod_restarted"),
    ],
  },
  {
    name: "retains active operations while deleting only expired terminal rows",
    fixture: "retention" as const,
    input: undefined,
    assert: [hasObserved<Context, unknown>("removed", 1), hasObserved<Context, unknown>("state", "running")],
  },
] satisfies readonly OperationCase<Action, undefined, unknown, Context>[];

const operationTable: OperationTable<Fixture, Action, undefined, unknown, Context> = {
  defaultFixture: () => createFixture("create"),
  fixtures: {
    create: () => createFixture("create"),
    existing: () => createFixture("existing"),
    conflict: () => createFixture("conflict"),
    cancel: () => createFixture("cancel"),
    recover: () => createFixture("recover"),
    retention: () => createFixture("retention"),
  },
  cases: operationCases,
  execute: async (fixture) => {
    if (fixture.action === "create" || fixture.action === "existing" || fixture.action === "conflict") {
      fixture.result = await fixture.service.create({
        kind: "agent_session.cleanup",
        executor: "daemon",
        requestFingerprint: JSON.stringify({ b: 2, a: 1 }),
        idempotencyKey: "cleanup-key",
      });
      return fixture.result;
    }
    if (fixture.action === "cancel") {
      fixture.result = await fixture.service.cancel("running-operation-id");
      return fixture.result;
    }
    if (fixture.action === "recover") {
      await fixture.service.recoverDaemonOperations();
      return undefined;
    }
    fixture.result = await fixture.service.deleteExpired("2026-08-20T00:00:00.000Z");
    return fixture.result;
  },
  observe: async (fixture) => {
    const record = await fixture.repository.findById(OperationId.create(observedOperationId(fixture.action)));
    const result = fixture.result as { created?: boolean; operation?: OperationRecord } | undefined;
    return {
      state: record?.state,
      errorCode: record?.error?.code,
      created: result?.created,
      operationId: result?.operation?.id,
      aborted: fixture.controller?.signal.aborted ?? false,
      removed: typeof fixture.result === "number" ? fixture.result : undefined,
    };
  },
};

describe("operation service", () => {
  runOperationTable(it as unknown as TestRegistrar, operationTable);
});

function createFixture(action: Action): FixtureHandle<Fixture> {
  const repository = new MemoryOperationRepository();
  const service = new OperationService({
    repository,
    clock: {
      now: () => "2026-08-20T00:00:00.000Z",
      id: () => "new-operation-id",
    },
  });
  const fixture: Fixture = { action, repository, service };
  if (action === "existing") {
    repository.seed(
      createOperation("existing-operation-id", "agent_session.cleanup", "daemon", "running", {
        idempotencyKey: "cleanup-key",
        requestFingerprint: JSON.stringify({ a: 1, b: 2 }),
      }),
    );
  }
  if (action === "conflict") {
    repository.seed(
      createOperation("conflicting-operation-id", "agent_session.cleanup", "daemon", "running", {
        idempotencyKey: "cleanup-key",
        requestFingerprint: JSON.stringify({ a: 9 }),
      }),
    );
  }
  if (action === "cancel") {
    repository.seed(createOperation("running-operation-id", "agent_session.cleanup", "daemon", "running"));
    fixture.controller = new AbortController();
    service.registerCancellation("running-operation-id", fixture.controller);
  }
  if (action === "recover") {
    repository.seed(createOperation("daemon-operation-id", "agent_session.cleanup", "daemon", "running"));
  }
  if (action === "retention") {
    repository.seed(
      createOperation("expired-operation-id", "agent_session.cleanup", "daemon", "succeeded", {
        completedAt: "2026-08-19T00:00:00.000Z",
      }),
    );
    repository.seed(createOperation("active-operation-id", "agent_session.cleanup", "daemon", "running"));
  }
  return { fixture };
}

function observedOperationId(action: Action): string {
  if (action === "cancel") return "running-operation-id";
  if (action === "recover") return "daemon-operation-id";
  if (action === "retention") return "active-operation-id";
  if (action === "existing") return "existing-operation-id";
  if (action === "conflict") return "conflicting-operation-id";
  return "new-operation-id";
}

function createOperation(
  id: string,
  kind: string,
  executor: "client" | "daemon",
  state: OperationState,
  overrides: {
    idempotencyKey?: string;
    requestFingerprint?: string;
    completedAt?: string;
  } = {},
): OperationRecord {
  const created = Operation.create({
    id: OperationId.create(id),
    kind,
    executor,
    requestFingerprint: overrides.requestFingerprint ?? JSON.stringify({ operation: kind }),
    ...(overrides.idempotencyKey === undefined ? {} : { idempotencyKey: overrides.idempotencyKey }),
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  });
  if (state === "queued") return created;
  if (state === "running") return Operation.start(created, "2026-08-19T00:00:01.000Z");
  if (state === "succeeded") {
    const started = Operation.start(created, "2026-08-19T00:00:01.000Z");
    return Operation.succeed(started, overrides.completedAt ?? "2026-08-19T00:00:02.000Z", {});
  }
  if (state === "failed") {
    const started = Operation.start(created, "2026-08-19T00:00:01.000Z");
    return Operation.fail(started, overrides.completedAt ?? "2026-08-19T00:00:02.000Z", {
      code: "seeded_failure",
      message: "seeded failure",
    });
  }
  const started = Operation.start(created, "2026-08-19T00:00:01.000Z");
  return Operation.cancel(started, overrides.completedAt ?? "2026-08-19T00:00:02.000Z");
}

class MemoryOperationRepository implements OperationRepository {
  private readonly records = new Map<string, OperationRecord>();

  public seed(operation: OperationRecord): void {
    this.records.set(operation.id, operation);
  }

  public async findById(id: OperationId): Promise<OperationRecord | undefined> {
    return this.records.get(id);
  }

  public async findByIdempotencyKey(kind: string, idempotencyKey: string): Promise<OperationRecord | undefined> {
    return [...this.records.values()].find(
      (operation) => operation.kind === kind && operation.idempotencyKey === idempotencyKey,
    );
  }

  public async insertIfAbsent(operation: OperationRecord): Promise<boolean> {
    if (
      this.records.has(operation.id) ||
      [...this.records.values()].some(
        (current) =>
          current.kind === operation.kind &&
          current.idempotencyKey !== undefined &&
          current.idempotencyKey === operation.idempotencyKey,
      )
    ) {
      return false;
    }
    this.records.set(operation.id, operation);
    return true;
  }

  public async update(operation: OperationRecord, expectedUpdatedAt?: string): Promise<boolean> {
    const current = this.records.get(operation.id);
    if (!current || (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt)) return false;
    this.records.set(operation.id, operation);
    return true;
  }

  public async listActive(): Promise<OperationRecord[]> {
    return [...this.records.values()].filter(
      (operation) => operation.state === "queued" || operation.state === "running",
    );
  }

  public async deleteCompletedBefore(before: string): Promise<number> {
    const expired = [...this.records.values()].filter(
      (operation) =>
        operation.state !== "queued" &&
        operation.state !== "running" &&
        operation.completedAt !== undefined &&
        operation.completedAt < before,
    );
    for (const operation of expired) this.records.delete(operation.id);
    return expired.length;
  }
}
