import { AgentSessionId } from "@muximo/domain";
import type { MuximodHostPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import { controlFailure } from "./control-failure.js";

export async function adoptAgentSession(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore = new Map(),
  request: { agentSessionId: string; tmuxPaneId: string; executionId: string },
): Promise<void> {
  const session = await agentSessionRepository.findById(AgentSessionId.create(request.agentSessionId));
  if (!session) throw controlFailure("agent_session_not_found", `agent session not found: ${request.agentSessionId}`);
  if (session.executionId !== request.executionId)
    throw controlFailure("agent_execution_mismatch", "agent execution is no longer current");
  const live = host.listPanesSnapshot();
  if (!live.available) throw controlFailure("tmux_unavailable", "tmux is unavailable");
  const pane = live.panes.find((candidate) => candidate.paneId === request.tmuxPaneId);
  if (!pane) throw controlFailure("tmux_pane_not_found", `tmux pane not found: ${request.tmuxPaneId}`);
  host.setAgentExecutionMetadata(pane.paneId, session.id, request.executionId);
  await reconcilePanes(host, paneRepository, agentSessionRepository, host.listPanesSnapshot(), agentStatus);
}
