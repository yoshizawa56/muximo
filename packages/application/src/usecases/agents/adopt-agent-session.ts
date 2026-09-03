import { AgentSessionId } from "@muximo/domain";
import { Effect } from "effect";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import { AgentSessionRepositoryService, MuximodHostService } from "../terminals/terminal-services.js";
import { controlFailure } from "./control-failure.js";

export const adoptAgentSession = Effect.fn("AgentSessions.adopt")(function* (request: {
  agentSessionId: string;
  hostPaneId: string;
  executionId: string;
}) {
  const host = yield* MuximodHostService;
  const agentSessionRepository = yield* AgentSessionRepositoryService;
  const session = yield* agentSessionRepository.findById(AgentSessionId.create(request.agentSessionId));
  if (!session)
    return yield* Effect.fail(
      controlFailure("agent_session_not_found", `agent session not found: ${request.agentSessionId}`),
    );
  if (session.executionId !== request.executionId) {
    return yield* Effect.fail(controlFailure("agent_execution_mismatch", "agent execution is no longer current"));
  }
  const live = yield* host.listPanesSnapshot();
  if (!live.available)
    return yield* Effect.fail(controlFailure("terminal_host_unavailable", "terminal host is unavailable"));
  const pane = live.panes.find((candidate) => candidate.hostPaneId === request.hostPaneId);
  if (!pane) {
    return yield* Effect.fail(
      controlFailure("terminal_host_pane_not_found", `terminal host pane not found: ${request.hostPaneId}`),
    );
  }
  yield* host.setAgentExecutionMetadata(pane.hostPaneId, session.id, request.executionId);
  const reconciledSnapshot = yield* host.listPanesSnapshot();
  yield* reconcilePanes(reconciledSnapshot);
});
