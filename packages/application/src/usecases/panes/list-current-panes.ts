import type { PaneRecord } from "@muximo/domain";
import type { MuximodHostPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";

export async function listCurrentPanes(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore = new Map(),
  sessionName?: string,
): Promise<PaneRecord[]> {
  const panes = await reconcilePanes(host, paneRepository, agentSessionRepository, undefined, agentStatus);
  return sessionName ? panes.filter((pane) => pane.sessionName === sessionName) : panes;
}
