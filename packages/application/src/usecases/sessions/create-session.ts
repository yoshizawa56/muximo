import { clearPatch, Pane, type PaneRecord, WorkspaceId } from "@muximo/domain";
import { ApplicationError, type MuximodClock, type MuximodSessionSummary } from "../../ports/application.js";
import type { MuximodHostPort, MuximodWorkspaceCatalogPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository, WorkspaceRepository } from "../../ports/repositories.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import { summarizeSessions } from "./summarize-sessions.js";

export async function createSession(
  input: { name: string; cwd?: string; workspaceId?: string },
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  workspaceCatalog: MuximodWorkspaceCatalogPort,
  workspaceRepository: WorkspaceRepository,
  agentStatus: AgentStatusStore,
  clock: MuximodClock,
): Promise<MuximodSessionSummary> {
  const cwd = await resolveInitialCwd(input, workspaceCatalog, workspaceRepository);
  if (await host.hasSession(input.name)) {
    throw new ApplicationError("session_exists", `terminal host session already exists: ${input.name}`);
  }

  let created = false;
  try {
    const managedSessionId = await host.createManagedSession(input.name, cwd);
    created = true;
    const panes = await reconcilePanes(host, paneRepository, agentSessionRepository, agentStatus, clock);
    const initialPane = panes.find((pane) => pane.sessionName === input.name);
    let shellPane: PaneRecord | undefined;
    if (initialPane) {
      shellPane = Pane.update(initialPane, {
        kind: "shell",
        agentId: clearPatch,
      });
      if (shellPane.state !== "running") {
        shellPane = Pane.transitionState(shellPane, "running", "session created", clock.now());
      }
      await paneRepository.upsert(shellPane);
      await host.setAgentPaneMetadata(initialPane.hostPaneId, "kind", "shell");
      await host.setAgentPaneMetadata(initialPane.hostPaneId, "agent_id", "");
      await host.setAgentPaneMetadata(initialPane.hostPaneId, "managed_session_id", managedSessionId);
    }
    const currentPanes =
      initialPane && shellPane ? panes.map((pane) => (pane.id === initialPane.id ? shellPane : pane)) : panes;
    const session = summarizeSessions(
      currentPanes.filter((pane) => pane.sessionName === input.name),
      new Set([input.name]),
    ).find((candidate) => candidate.name === input.name);
    if (!session || !currentPanes.some((pane) => pane.sessionName === input.name)) {
      throw new ApplicationError("session_not_visible", "terminal host created the session but it could not be read");
    }
    return session;
  } catch (error) {
    if (created) {
      try {
        await host.killSession(input.name);
      } catch {
        // Preserve the original setup error; cleanup is best effort.
      }
    }
    throw error;
  }
}

async function resolveInitialCwd(
  input: { cwd?: string; workspaceId?: string },
  workspaceCatalog: MuximodWorkspaceCatalogPort,
  workspaceRepository: WorkspaceRepository,
): Promise<string> {
  if (input.workspaceId) {
    const workspace = await workspaceCatalog.resolveWorkspaceDirectory(WorkspaceId.create(input.workspaceId), (id) =>
      workspaceRepository.findById(id),
    );
    return workspace.rootPath;
  }
  if (input.cwd) return workspaceCatalog.resolveLegacyDirectory(input.cwd);
  throw new ApplicationError("session_cwd_required", "A session working directory is required");
}
