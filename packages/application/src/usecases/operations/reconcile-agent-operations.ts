import { AgentSessionId, type OperationRecord } from "@muximo/domain";
import type {
  AgentExecutionReceipt,
  ManagedAgentSessionRepository,
  ProcessObservationPort,
} from "../../ports/agent-sessions.js";
import type { OperationService } from "./operation-service.js";
import { settleAgentExecutionOperation } from "./settle-agent-execution-operation.js";

export type ReconcileAgentOperationsDependencies = {
  operations: OperationService;
  sessions: ManagedAgentSessionRepository;
  process: ProcessObservationPort;
};

/** Reconciles client-owned operations after a daemon restart without replaying provider work. */
export class ReconcileAgentOperations {
  public constructor(private readonly deps: ReconcileAgentOperationsDependencies) {}

  public async execute(): Promise<void> {
    for (const operation of await this.deps.operations.listActive()) {
      if (operation.executor !== "client") continue;
      await this.reconcile(operation);
    }
  }

  private async reconcile(operation: OperationRecord): Promise<void> {
    const subject = operation.subject;
    if (subject?.type !== "agent_session" || subject.executionId === undefined) {
      await this.deps.operations.fail(
        operation.id,
        {
          code: "muximod_restarted",
          message: "muximod restarted before the client-owned execution identity was recorded",
        },
        "The prepared agent execution cannot be reconstructed after a muximod restart",
      );
      return;
    }

    const receipt = await this.deps.sessions.findExecutionReceipt(subject.executionId);
    if (receipt) {
      await this.reconcileReceipt(operation, subject.id, receipt);
      return;
    }

    const session = await this.deps.sessions.findById(AgentSessionId.create(subject.id));
    if (!session || session.executionId !== subject.executionId) {
      await this.failLostExecution(operation, "client_execution_result_lost");
      return;
    }
    if (session.status !== "running" && session.status !== "resuming") {
      await this.failLostExecution(operation, "client_execution_result_lost");
      return;
    }
    if (session.executionOwnerPid === undefined || session.executionOwnerStartedAt === undefined) {
      await this.failLostExecution(operation, "client_execution_owner_unknown");
      return;
    }

    const ownerLiveness = await this.deps.process.observe(session.executionOwnerPid, session.executionOwnerStartedAt);
    if (ownerLiveness === "alive" || ownerLiveness === "unknown") return;
    await this.failLostExecution(operation, "client_execution_owner_lost");
  }

  private async reconcileReceipt(
    operation: OperationRecord,
    agentSessionId: string,
    receipt: AgentExecutionReceipt,
  ): Promise<void> {
    const expectedOperation = operation.kind === "agent_session.run" ? "run" : "resume";
    if (
      receipt.operation !== expectedOperation ||
      receipt.agentSessionId !== agentSessionId ||
      receipt.executionId !== operation.subject?.executionId
    ) {
      await this.deps.operations.fail(
        operation.id,
        {
          code: "operation_receipt_mismatch",
          message: "the stored agent execution receipt does not match the operation",
        },
        "The daemon refused to apply a receipt belonging to a different execution",
      );
      return;
    }
    await settleAgentExecutionOperation(this.deps.operations, operation.id, {
      process: receipt.process,
      session: receipt.session,
      ...(receipt.operation === "run" ? { cleanup: receipt.cleanup } : {}),
    });
  }

  private async failLostExecution(operation: OperationRecord, code: string): Promise<void> {
    await this.deps.operations.fail(
      operation.id,
      {
        code,
        message: "the client-owned agent execution did not produce a durable completion receipt",
      },
      "The operation remains failed because muximod cannot safely replay host-owned execution or cleanup",
    );
  }
}
