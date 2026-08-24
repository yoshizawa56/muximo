import { AgentSessionId, type PaneState } from "@muximo/domain";
import type { MuximodClock } from "../../ports/application.js";
import type { MuximodHostPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import { type AgentStatusStore, agentStatusKey, normalizeAgentStatusObservation } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import { controlFailure } from "./control-failure.js";

export async function observeAgentSession(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore,
  clock: MuximodClock,
  request: { agentSessionId: string; hostPaneId: string; executionId: string; state: PaneState; recentOutput?: string },
): Promise<void> {
  const session = await agentSessionRepository.findById(AgentSessionId.create(request.agentSessionId));
  if (!session) throw controlFailure("agent_session_not_found", `agent session not found: ${request.agentSessionId}`);
  if (session.executionId !== request.executionId)
    throw controlFailure("agent_execution_mismatch", "agent execution is no longer current");
  const live = await host.listPanesSnapshot();
  if (!live.available) throw controlFailure("terminal_host_unavailable", "terminal host is unavailable");
  const pane = live.panes.find((candidate) => candidate.hostPaneId === request.hostPaneId);
  if (!pane)
    throw controlFailure("terminal_host_pane_not_found", `terminal host pane not found: ${request.hostPaneId}`);
  if (pane.muximodSessionId !== request.agentSessionId || pane.muximodExecutionId !== request.executionId) {
    throw controlFailure("agent_execution_not_adopted", "agent execution is not associated with the requested pane");
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
  await reconcilePanes(host, paneRepository, agentSessionRepository, agentStatus, clock, live);
}
