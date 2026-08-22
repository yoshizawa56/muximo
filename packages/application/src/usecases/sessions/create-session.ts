import { clearPatch, Pane } from "@muximo/domain";
import { ApplicationError, type MuximodSessionSummary } from "../../ports/application.js";
import type { MuximodHostPort, MuximodWorkspaceCatalogPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import { summarizeSessions } from "./summarize-sessions.js";

export async function createSession(
  input: { name: string; initialCwd: string },
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  workspaceCatalog: MuximodWorkspaceCatalogPort,
  agentStatus: AgentStatusStore = new Map(),
): Promise<MuximodSessionSummary> {
  const cwd = await workspaceCatalog.resolveLegacyDirectory(input.initialCwd);
  if (host.hasSession(input.name)) {
    throw new ApplicationError("session_exists", `tmux session already exists: ${input.name}`);
  }

  let created = false;
  try {
    const managedSessionId = host.createManagedSession(input.name, cwd);
    created = true;
    const panes = await reconcilePanes(host, paneRepository, agentSessionRepository, undefined, agentStatus);
    const initialPane = panes.find((pane) => pane.sessionName === input.name);
    if (initialPane) {
      const shellPane = Pane.update(initialPane, {
        kind: "shell",
        agentId: clearPatch,
        state: "running",
      });
      await paneRepository.upsert(shellPane);
      host.setAgentPaneMetadata(initialPane.tmuxPaneId, "kind", "shell");
      host.setAgentPaneMetadata(initialPane.tmuxPaneId, "agent_id", "");
      host.setAgentPaneMetadata(initialPane.tmuxPaneId, "managed_session_id", managedSessionId);
    }
    const currentPanes = initialPane
      ? panes.map((pane) =>
          pane.id === initialPane.id
            ? Pane.update(pane, { kind: "shell", agentId: clearPatch, state: "running" })
            : pane,
        )
      : panes;
    const session = summarizeSessions(currentPanes.filter((pane) => pane.sessionName === input.name)).find(
      (candidate) => candidate.name === input.name,
    );
    if (!session || !currentPanes.some((pane) => pane.sessionName === input.name)) {
      throw new ApplicationError("session_not_visible", "tmux created the session but muximod could not read it");
    }
    return session;
  } catch (error) {
    if (created) {
      try {
        host.killSession(input.name);
      } catch {
        // Preserve the original setup error; cleanup is best effort.
      }
    }
    throw error;
  }
}
