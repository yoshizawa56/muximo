import type { ApplicationClock } from "../../ports/application.js";
import type { MuximodHostPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import { type AgentStatusStore, agentStatusKey } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";

export async function releaseAgentSession(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore,
  clock: ApplicationClock,
  request: { agentSessionId: string; hostPaneId: string; executionId: string },
): Promise<void> {
  const live = await host.listPanesSnapshot();
  if (!live.available) return;
  const pane = live.panes.find((candidate) => candidate.hostPaneId === request.hostPaneId);
  if (!pane) return;
  if (pane.muximodSessionId === request.agentSessionId && pane.muximodExecutionId === request.executionId) {
    agentStatus.delete(agentStatusKey(request.agentSessionId, request.executionId));
    if (!(await host.clearAgentExecutionMetadata(pane.hostPaneId, request.executionId))) return;
    await host.resetAgentPaneMetadata(pane.hostPaneId);
    const reconciledSnapshot = await host.listPanesSnapshot();
    await reconcilePanes(host, paneRepository, agentSessionRepository, agentStatus, clock, reconciledSnapshot);
  }
}
