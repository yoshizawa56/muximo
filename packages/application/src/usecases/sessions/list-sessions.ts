import type { MuximodClock, MuximodSessionSummary } from "../../ports/application.js";
import type { MuximodHostPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import { summarizeSessions } from "./summarize-sessions.js";

export async function listSessions(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore,
  clock: MuximodClock,
): Promise<MuximodSessionSummary[]> {
  const snapshot = await host.listPanesSnapshot();
  const panes = await reconcilePanes(host, paneRepository, agentSessionRepository, agentStatus, clock, snapshot);
  const managedSessionNames = new Set(
    snapshot.panes.filter((pane) => pane.muximodManagedSessionId).map((pane) => pane.sessionName),
  );
  return summarizeSessions(panes, managedSessionNames);
}
