import type { CleanupAgentSessionInput } from "../../ports/agent-sessions.js";
import type { OperationStatus } from "../../ports/operations.js";
import { OperationCancelledError } from "../../ports/operations.js";
import type { OperationService } from "../operations/operation-service.js";
import type { CleanupAgentSessionPort } from "./cleanup-session.js";

export type StartCleanupAgentSessionDependencies = {
  operations: OperationService;
  cleanup: CleanupAgentSessionPort;
};

/** Starts daemon-owned cleanup and returns before external archive or Git work completes. */
export class StartCleanupAgentSession {
  public constructor(private readonly deps: StartCleanupAgentSessionDependencies) {}

  public async execute(input: CleanupAgentSessionInput): Promise<OperationStatus> {
    const allocation = await this.deps.operations.create({
      kind: "agent_session.cleanup",
      executor: "daemon",
      requestFingerprint: cleanupFingerprint(input),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
    if (!allocation.created) return this.deps.operations.get(allocation.operation.id);

    try {
      await this.deps.operations.start(allocation.operation.id);
    } catch (error) {
      await this.deps.operations.fail(allocation.operation.id, error).catch(() => undefined);
      throw error;
    }
    const controller = new AbortController();
    this.deps.operations.registerCancellation(allocation.operation.id, controller);
    void this.run(allocation.operation.id, input, controller).catch(() => undefined);
    return this.deps.operations.get(allocation.operation.id);
  }

  private async run(operationId: string, input: CleanupAgentSessionInput, controller: AbortController): Promise<void> {
    let mutationStarted = false;
    try {
      const result = await this.deps.cleanup.execute(input, {
        signal: controller.signal,
        onMutationStarted: () => {
          mutationStarted = true;
        },
      });
      // Cleanup deliberately becomes non-cancellable once it starts mutating
      // external state. A late cancellation request is retained on the
      // operation, while the actual cleanup result remains authoritative.
      if (result.cleanup.disposition === "failed") {
        await this.deps.operations.fail(
          operationId,
          {
            code: "agent_cleanup_failed",
            message: "agent session cleanup failed",
            details: { cleanup: result.cleanup },
          },
          undefined,
          undefined,
          result,
        );
      } else {
        await this.deps.operations.succeed(operationId, result);
      }
    } catch (error) {
      if (!mutationStarted && (controller.signal.aborted || isCancellation(error))) {
        await this.deps.operations.finishCancellation(operationId);
      } else {
        await this.deps.operations.fail(operationId, error);
      }
    } finally {
      this.deps.operations.unregisterCancellation(operationId, controller);
    }
  }
}

function cleanupFingerprint(input: CleanupAgentSessionInput): string {
  return JSON.stringify({
    workspaceScope: input.workspaceScope,
    force: input.force,
    reference: input.reference,
  });
}

function isCancellation(error: unknown): boolean {
  return error instanceof OperationCancelledError || (isRecord(error) && error.code === "operation_cancelled");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
