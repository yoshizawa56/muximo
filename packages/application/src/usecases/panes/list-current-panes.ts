import type { PaneRecord } from "@muximo/domain";
import type { MuximodClock } from "../../ports/application.js";
import type { MuximodHostPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";

export async function listCurrentPanes(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore,
  clock: MuximodClock,
  sessionName?: string,
): Promise<PaneRecord[]> {
  const panes = await reconcilePanes(host, paneRepository, agentSessionRepository, agentStatus, clock);
  return sessionName ? panes.filter((pane) => pane.sessionName === sessionName) : panes;
}
