import type { MuximodHostPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import { type AgentStatusStore, agentStatusKey } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";

export async function releaseAgentSession(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore = new Map(),
  request: { agentSessionId: string; tmuxPaneId: string; executionId: string },
): Promise<void> {
  const live = host.listPanesSnapshot();
  if (!live.available) return;
  const pane = live.panes.find((candidate) => candidate.paneId === request.tmuxPaneId);
  if (!pane) return;
  if (pane.muximodSessionId === request.agentSessionId && pane.muximodExecutionId === request.executionId) {
    agentStatus.delete(agentStatusKey(request.agentSessionId, request.executionId));
    if (!host.clearAgentExecutionMetadata(pane.paneId, request.executionId)) return;
    host.resetAgentPaneMetadata(pane.paneId);
    await reconcilePanes(host, paneRepository, agentSessionRepository, host.listPanesSnapshot(), agentStatus);
  }
}
