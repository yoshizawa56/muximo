import { Effect } from "effect";
import { agentStatusKey } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import { AgentStatusService, MuximodHostService } from "../terminals/terminal-services.js";

export const releaseAgentSession = Effect.fn("AgentSessions.release")(function* (request: {
  agentSessionId: string;
  hostPaneId: string;
  executionId: string;
}) {
  const host = yield* MuximodHostService;
  const agentStatus = yield* AgentStatusService;
  const live = yield* host.listPanesSnapshot();
  if (!live.available) return;
  const pane = live.panes.find((candidate) => candidate.hostPaneId === request.hostPaneId);
  if (!pane) return;
  if (pane.muximodSessionId === request.agentSessionId && pane.muximodExecutionId === request.executionId) {
    agentStatus.delete(agentStatusKey(request.agentSessionId, request.executionId));
    if (!(yield* host.clearAgentExecutionMetadata(pane.hostPaneId, request.executionId))) return;
    yield* host.resetAgentPaneMetadata(pane.hostPaneId);
    const reconciledSnapshot = yield* host.listPanesSnapshot();
    yield* reconcilePanes(reconciledSnapshot);
  }
});
