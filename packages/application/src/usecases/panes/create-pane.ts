import type { WorkspaceRecord } from "@muximo/domain";
import { normalizeAgentSessionName, Pane, WorkspaceId } from "@muximo/domain";
import type { CreatePaneInput } from "../../ports/application.js";
import { ApplicationError, type MuximodPaneSummary } from "../../ports/application.js";
import type { MuximodHostPort, MuximodViewportPort, MuximodWorkspaceCatalogPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";

export async function createPane(
  input: CreatePaneInput,
  host: MuximodHostPort,
  repository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  viewportManager: MuximodViewportPort,
  workspaceCatalog: MuximodWorkspaceCatalogPort,
  agentStatus: AgentStatusStore = new Map(),
  workspace?: WorkspaceRecord,
): Promise<MuximodPaneSummary> {
  if (!host.hasSession(input.sessionName)) {
    throw new ApplicationError("session_not_found", `tmux session does not exist: ${input.sessionName}`);
  }
  if (input.placement !== "window" && (input.cwd || (input.workspaceId && !input.useWorktree))) {
    throw new ApplicationError(
      "split_directory_override_unsupported",
      "Split panes always inherit the target pane cwd",
    );
  }
  if (input.kind === "agent" && !input.agentId) {
    throw new ApplicationError("agent_required", "agentId is required for an agent pane");
  }
  if (input.kind === "shell" && input.agentId) {
    throw new ApplicationError("agent_not_allowed", "agentId is not allowed for a shell pane");
  }

  const cwd =
    input.placement === "window"
      ? input.cwd
        ? await workspaceCatalog.resolveLegacyDirectory(input.cwd)
        : workspace?.rootPath
      : undefined;

  const paneName = input.kind === "agent" ? normalizeAgentSessionName(input.name) : input.name;
  const commandInput = paneName === input.name ? input : { ...input, name: paneName };
  const tmuxPaneId = host.createManagedPane(commandInput, workspace, cwd);
  if (input.placement !== "window" && input.targetPaneId) {
    viewportManager.reassertMobileViewport(input.targetPaneId);
  }
  const panes = await reconcilePanes(host, repository, agentSessionRepository, undefined, agentStatus);
  const current = panes.find((pane) => pane.tmuxPaneId === tmuxPaneId);
  if (!current) {
    throw new ApplicationError("pane_not_visible", "tmux created the pane but muximod could not read it");
  }

  const workspaceId = input.workspaceId === undefined ? current.workspaceId : WorkspaceId.create(input.workspaceId);
  const record: MuximodPaneSummary = Pane.create({
    ...current,
    kind: input.kind,
    name: paneName,
    workspaceId,
    agentId: input.agentId ?? undefined,
    state: input.kind === "agent" ? "starting" : "running",
  });
  await repository.upsert(record);
  host.setAgentPaneMetadata(tmuxPaneId, "pane_id", record.id);
  host.setAgentPaneMetadata(tmuxPaneId, "pane_name", paneName);
  host.setAgentPaneMetadata(tmuxPaneId, "agent_id", input.agentId ?? "");
  host.setAgentPaneMetadata(tmuxPaneId, "kind", input.kind);
  host.setAgentPaneMetadata(tmuxPaneId, "workspace_id", input.workspaceId ?? "");
  return record;
}
