import type {
  AgentExecutionResult,
  ResumeAgentSessionResult,
  RunAgentSessionResult,
} from "../../ports/agent-sessions.js";
import type { OperationStatus } from "../../ports/operations.js";
import type { OperationService } from "./operation-service.js";

export type AgentExecutionOperationOutcome = {
  process: AgentExecutionResult;
  session: RunAgentSessionResult["session"] | ResumeAgentSessionResult["session"];
  cleanup?: RunAgentSessionResult["cleanup"];
};

/** Commits a host-owned execution result to the durable operation state. */
export async function settleAgentExecutionOperation(
  operations: OperationService,
  operationId: string,
  outcome: AgentExecutionOperationOutcome,
): Promise<OperationStatus> {
  const result = toOperationResult(outcome);
  if (isInterrupted(outcome.process)) return operations.finishCancellation(operationId, result);

  if (outcome.process.code !== 0 || outcome.cleanup?.disposition === "failed") {
    const cleanupFailure = outcome.cleanup?.disposition === "failed";
    return operations.fail(
      operationId,
      {
        code: cleanupFailure ? "agent_cleanup_failed" : "agent_process_failed",
        message: cleanupFailure ? "agent execution cleanup failed" : "agent process exited unsuccessfully",
        details: {
          process: {
            started: outcome.process.started,
            code: outcome.process.code,
            interrupted: outcome.process.interrupted,
            signal: outcome.process.signal ?? null,
          },
          ...(cleanupFailure ? { cleanup: outcome.cleanup } : {}),
        },
      },
      outcome.process.failureDiagnostic,
      undefined,
      result,
    );
  }

  return operations.succeed(operationId, result);
}

function isInterrupted(process: AgentExecutionResult): boolean {
  return process.interrupted || process.code === 130 || process.code === 143;
}

function toOperationResult(outcome: AgentExecutionOperationOutcome) {
  return {
    process: {
      started: outcome.process.started,
      code: outcome.process.code,
      interrupted: outcome.process.interrupted,
      ...(outcome.process.signal === undefined ? {} : { signal: outcome.process.signal }),
      ...(outcome.process.failureDiagnostic === undefined
        ? {}
        : { failureDiagnostic: outcome.process.failureDiagnostic }),
    },
    session: outcome.session,
    ...(outcome.cleanup === undefined ? {} : { cleanup: outcome.cleanup }),
  };
}
