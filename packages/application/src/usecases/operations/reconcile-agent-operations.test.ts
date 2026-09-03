import {
  AgentSession,
  AgentSessionId,
  Operation,
  OperationId,
  type OperationRecord,
  WorkspaceId,
} from "@muximo/domain";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type {
  AgentExecutionReceipt,
  ManagedAgentSessionRepository,
  ProcessLiveness,
} from "../../ports/agent-sessions.js";
import type { OperationRepository } from "../../ports/operations.js";
import { OperationService } from "./operation-service.js";
import { ReconcileAgentOperations } from "./reconcile-agent-operations.js";

type Action =
  | "receipt-success"
  | "receipt-failure"
  | "owner-alive"
  | "owner-unknown"
  | "owner-dead"
  | "no-subject"
  | "exited";
type Fixture = {
  action: Action;
  repository: MemoryOperationRepository;
  sessions: ManagedAgentSessionRepository;
  service: OperationService;
  reconciler: ReconcileAgentOperations;
  liveness: ProcessLiveness;
  recordId: string;
};
type Context = { state: string | undefined; errorCode: string | undefined };

const cases = [
  {
    name: "reconstructs a successful client operation from its durable receipt",
    fixture: "receipt-success" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "succeeded"),
      hasObserved<Context, unknown>("errorCode", undefined),
    ],
  },
  {
    name: "reconstructs a failed client operation from a nonzero receipt",
    fixture: "receipt-failure" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "failed"),
      hasObserved<Context, unknown>("errorCode", "agent_process_failed"),
    ],
  },
  {
    name: "keeps an operation active while its CLI owner is alive",
    fixture: "owner-alive" as const,
    input: undefined,
    assert: [hasObserved<Context, unknown>("state", "running"), hasObserved<Context, unknown>("errorCode", undefined)],
  },
  {
    name: "keeps an operation active when process identity cannot be verified",
    fixture: "owner-unknown" as const,
    input: undefined,
    assert: [hasObserved<Context, unknown>("state", "running"), hasObserved<Context, unknown>("errorCode", undefined)],
  },
  {
    name: "fails an operation when its CLI owner is gone",
    fixture: "owner-dead" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "failed"),
      hasObserved<Context, unknown>("errorCode", "client_execution_owner_lost"),
    ],
  },
  {
    name: "fails a prepared operation that lost its execution identity during restart",
    fixture: "no-subject" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "failed"),
      hasObserved<Context, unknown>("errorCode", "muximod_restarted"),
    ],
  },
  {
    name: "fails an operation whose session finalized without a receipt",
    fixture: "exited" as const,
    input: undefined,
    assert: [
      hasObserved<Context, unknown>("state", "failed"),
      hasObserved<Context, unknown>("errorCode", "client_execution_result_lost"),
    ],
  },
] satisfies readonly OperationCase<Action, undefined, unknown, Context>[];

const table: OperationTable<Fixture, Action, undefined, unknown, Context> = {
  defaultFixture: () => createFixture("receipt-success"),
  fixtures: {
    "receipt-success": () => createFixture("receipt-success"),
    "receipt-failure": () => createFixture("receipt-failure"),
    "owner-alive": () => createFixture("owner-alive"),
    "owner-unknown": () => createFixture("owner-unknown"),
    "owner-dead": () => createFixture("owner-dead"),
    "no-subject": () => createFixture("no-subject"),
    exited: () => createFixture("exited"),
  },
  cases,
  execute: async (fixture) => {
    await fixture.reconciler.execute();
    return undefined;
  },
  observe: async (fixture) => {
    const record = await fixture.repository.findById(OperationId.create(fixture.recordId));
    return { state: record?.state, errorCode: record?.error?.code };
  },
};

describe("client-owned operation reconciliation", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFixture(action: Action): FixtureHandle<Fixture> {
  const repository = new MemoryOperationRepository();
  const service = new OperationService({
    repository,
    clock: { now: () => "2026-08-20T00:00:00.000Z", id: () => "generated-operation-id" },
  });
  const executionId = "execution-id-123456";
  const session = AgentSession.create({
    id: AgentSessionId.create("agent-session-id"),
    name: "review",
    backend: "codex",
    status: action === "exited" ? "exited" : "running",
    workspaceId: WorkspaceId.create("workspace-id"),
    workspaceRoot: "/workspace/review",
    workspaceName: "workspace",
    useWorktree: false,
    setupRan: false,
    resuming: false,
    executionId,
    executionStartedAt: "2026-08-20T00:00:01.000Z",
    executionOwnerPid: 42,
    executionOwnerStartedAt: "2026-08-20T00:00:01.000Z",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  const operation = createOperation(
    action === "no-subject"
      ? undefined
      : {
          type: "agent_session",
          id: session.id,
          executionId,
        },
  );
  repository.seed(operation);
  const receipt =
    action === "receipt-success" || action === "receipt-failure"
      ? createReceipt(session, action === "receipt-success" ? 0 : 7)
      : undefined;
  const sessions: ManagedAgentSessionRepository = {
    findById: async (id) => (id === session.id ? session : undefined),
    findByName: async () => undefined,
    list: async () => [session],
    insert: async () => undefined,
    update: async () => undefined,
    claimExecution: async () => false,
    claimAbandonedExecution: async () => false,
    attachExecution: async () => false,
    delete: async () => undefined,
    findExecutionReceipt: async (id) => (id === receipt?.executionId ? receipt : undefined),
    saveExecutionReceipt: async () => undefined,
  };
  const fixture: Fixture = {
    action,
    repository,
    sessions,
    service,
    reconciler: new ReconcileAgentOperations({
      operations: service,
      sessions,
      process: { observe: async () => livenessFor(action) },
    }),
    liveness: livenessFor(action),
    recordId: operation.id,
  };
  return { fixture };
}

function createOperation(subject?: { type: string; id: string; executionId: string }): OperationRecord {
  const operation = Operation.create({
    id: OperationId.create("reconcile-operation-id"),
    kind: "agent_session.run",
    executor: "client",
    requestFingerprint: JSON.stringify({ operation: "run" }),
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  });
  return Operation.start(operation, "2026-08-20T00:00:01.000Z", subject);
}

function createReceipt(session: AgentExecutionReceipt["session"], code: number): AgentExecutionReceipt {
  return {
    operation: "run",
    agentSessionId: session.id,
    executionId: session.executionId ?? "execution-id-123456",
    process: { started: true, code, interrupted: false, pid: 321 },
    session,
    cleanup: { disposition: "not_requested", reason: "no_worktree" },
  };
}

function livenessFor(action: Action): ProcessLiveness {
  if (action === "owner-alive") return "alive";
  if (action === "owner-unknown") return "unknown";
  return "dead";
}

class MemoryOperationRepository implements OperationRepository {
  private readonly records = new Map<string, OperationRecord>();

  public seed(operation: OperationRecord): void {
    this.records.set(operation.id, operation);
  }

  public async findById(id: OperationId): Promise<OperationRecord | undefined> {
    return this.records.get(id);
  }

  public async findByIdempotencyKey(): Promise<OperationRecord | undefined> {
    return undefined;
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
