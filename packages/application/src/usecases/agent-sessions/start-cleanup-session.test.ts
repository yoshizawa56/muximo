import { AgentSession, AgentSessionId, type OperationId, type OperationRecord, WorkspaceId } from "@muximo/domain";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { CleanupAgentSessionResult } from "../../ports/agent-sessions.js";
import type { OperationRepository, OperationStatus } from "../../ports/operations.js";
import { OperationCancelledError } from "../../ports/operations.js";
import { OperationService } from "../operations/operation-service.js";
import type { CleanupAgentSessionExecutionOptions, CleanupAgentSessionPort } from "./cleanup-session.js";
import { StartCleanupAgentSession } from "./start-cleanup-session.js";

type Action = "removed" | "failed" | "cancel-before-mutation" | "late-cancel";
type Fixture = {
  action: Action;
  operations: OperationService;
  start: StartCleanupAgentSession;
  repository: MemoryOperationRepository;
  completion?: Deferred<CleanupAgentSessionResult>;
  accepted?: OperationStatus;
  final?: OperationStatus;
};
type Context = {
  state: string | undefined;
  errorCode: string | undefined;
  cleanupDisposition: string | undefined;
  cancelRequested: boolean;
};

const cases = [
  {
    name: "settles a removed cleanup as succeeded",
    fixture: "removed" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "succeeded"),
      hasObserved<Context, unknown>("errorCode", undefined),
      hasObserved<Context, unknown>("cleanupDisposition", "removed"),
    ],
  },
  {
    name: "settles a cleanup disposition failure as failed",
    fixture: "failed" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "failed"),
      hasObserved<Context, unknown>("errorCode", "agent_cleanup_failed"),
      hasObserved<Context, unknown>("cleanupDisposition", "failed"),
    ],
  },
  {
    name: "cancels before cleanup mutation begins",
    fixture: "cancel-before-mutation" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "cancelled"),
      hasObserved<Context, unknown>("errorCode", undefined),
      hasObserved<Context, unknown>("cancelRequested", true),
    ],
  },
  {
    name: "preserves the cleanup result after a late cancellation",
    fixture: "late-cancel" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "succeeded"),
      hasObserved<Context, unknown>("errorCode", undefined),
      hasObserved<Context, unknown>("cleanupDisposition", "removed"),
      hasObserved<Context, unknown>("cancelRequested", true),
    ],
  },
] satisfies readonly OperationCase<Action, undefined, unknown, Context>[];

const table: OperationTable<Fixture, Action, undefined, unknown, Context> = {
  defaultFixture: () => createFixture("removed"),
  fixtures: {
    removed: () => createFixture("removed"),
    failed: () => createFixture("failed"),
    "cancel-before-mutation": () => createFixture("cancel-before-mutation"),
    "late-cancel": () => createFixture("late-cancel"),
  },
  cases,
  execute: async (fixture) => {
    fixture.accepted = await fixture.start.execute({
      workspaceScope: "current",
      force: true,
      reference: "review",
      idempotencyKey: `${fixture.action}-key`,
    });
    const accepted = fixture.accepted;
    if (!accepted) throw new Error("cleanup operation was not accepted");
    if (fixture.action === "cancel-before-mutation" || fixture.action === "late-cancel") {
      await fixture.operations.cancel(accepted.operationId);
    }
    if (fixture.completion && fixture.action === "late-cancel") fixture.completion.resolve(cleanupResult("removed"));
    fixture.final = await waitForTerminal(fixture.operations, accepted.operationId);
    return fixture.final;
  },
  observe: async (fixture) => {
    const status = fixture.final;
    const operationResult = status?.result;
    const result = isCleanupResult(operationResult) ? operationResult : undefined;
    return {
      state: status?.state,
      errorCode: status?.error?.code,
      cleanupDisposition: result?.cleanup.disposition,
      cancelRequested: status?.cancelRequestedAt !== undefined,
    };
  },
};

describe("start cleanup operation", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFixture(action: Action): FixtureHandle<Fixture> {
  const repository = new MemoryOperationRepository();
  const operations = new OperationService({
    repository,
    clock: {
      now: () => "2026-08-20T00:00:00.000Z",
      id: () => `${action}-operation-id`,
    },
  });
  const completion: Deferred<CleanupAgentSessionResult> | undefined =
    action === "cancel-before-mutation" || action === "late-cancel" ? deferred<CleanupAgentSessionResult>() : undefined;
  const cleanup: CleanupAgentSessionPort = {
    execute: async (_input, options: CleanupAgentSessionExecutionOptions = {}) => {
      if (action === "cancel-before-mutation") {
        await waitForAbort(options.signal);
        throw new OperationCancelledError();
      }
      if (action === "late-cancel") {
        options.onMutationStarted?.();
        return completion?.promise ?? cleanupResult("removed");
      }
      return cleanupResult(action === "failed" ? "failed" : "removed");
    },
  };
  return {
    fixture: {
      action,
      operations,
      start: new StartCleanupAgentSession({ operations, cleanup }),
      repository,
      ...(completion === undefined ? {} : { completion }),
    },
  };
}

function cleanupResult(disposition: "removed" | "failed"): CleanupAgentSessionResult {
  const session = AgentSession.create({
    id: AgentSessionId.create("agent-session-id"),
    name: "review",
    backend: "codex",
    status: "exited",
    workspaceId: WorkspaceId.create("workspace-id"),
    workspaceRoot: "/workspace",
    workspaceName: "workspace",
    useWorktree: false,
    setupRan: false,
    resuming: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  return {
    session,
    cleanup: disposition === "removed" ? { disposition } : { disposition, reason: "worktree_removal_failed" },
  };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal?.aborted) throw new OperationCancelledError();
  return new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new OperationCancelledError()), { once: true });
  });
}

async function waitForTerminal(operations: OperationService, operationId: string): Promise<OperationStatus> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await operations.get(operationId);
    if (status.state === "succeeded" || status.state === "failed" || status.state === "cancelled") return status;
    await Promise.resolve();
  }
  throw new Error(`operation did not settle: ${operationId}`);
}

function isCleanupResult(value: unknown): value is CleanupAgentSessionResult {
  return typeof value === "object" && value !== null && "cleanup" in value;
}

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void };

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

class MemoryOperationRepository implements OperationRepository {
  private readonly records = new Map<string, OperationRecord>();

  public async findById(id: OperationId): Promise<OperationRecord | undefined> {
    return this.records.get(id);
  }

  public async findByIdempotencyKey(kind: string, idempotencyKey: string): Promise<OperationRecord | undefined> {
    return [...this.records.values()].find(
      (operation) => operation.kind === kind && operation.idempotencyKey === idempotencyKey,
    );
  }

  public async insertIfAbsent(operation: OperationRecord): Promise<boolean> {
    if (this.records.has(operation.id)) return false;
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

  public async deleteCompletedBefore(): Promise<number> {
    return 0;
  }
}
