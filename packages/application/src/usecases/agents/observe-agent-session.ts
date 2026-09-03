import { AgentSessionId, type PaneState } from "@muximo/domain";
import { Effect } from "effect";
import { attemptSync } from "../../attempt.js";
import { agentStatusKey, normalizeAgentStatusObservation } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import {
  AgentSessionRepositoryService,
  AgentStatusService,
  MuximodHostService,
} from "../terminals/terminal-services.js";
import { controlFailure } from "./control-failure.js";

export const observeAgentSession = Effect.fn("AgentSessions.observe")(function* (request: {
  agentSessionId: string;
  hostPaneId: string;
  executionId: string;
  state: PaneState;
  recentOutput?: string;
}) {
  const host = yield* MuximodHostService;
  const agentSessionRepository = yield* AgentSessionRepositoryService;
  const agentStatus = yield* AgentStatusService;
  const sessionId = yield* attemptSync(() => AgentSessionId.create(request.agentSessionId));
  const session = yield* agentSessionRepository.findById(sessionId);
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
  if (pane.muximodSessionId !== request.agentSessionId || pane.muximodExecutionId !== request.executionId) {
    return yield* Effect.fail(
      controlFailure("agent_execution_not_adopted", "agent execution is not associated with the requested pane"),
    );
  }
  const key = agentStatusKey(request.agentSessionId, request.executionId);
  const previous = agentStatus.get(key);
  agentStatus.set(
    key,
    normalizeAgentStatusObservation({
      state: request.state,
      recentOutput: request.recentOutput ?? previous?.recentOutput,
    }),
  );
  yield* reconcilePanes(live);
});
