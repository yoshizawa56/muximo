import { clearPatch, normalizeAgentSessionName, Pane, WorkspaceId } from "@muximo/domain";
import type { ApplicationClock, CreatePaneInput } from "../../ports/application.js";
import { ApplicationError, type MuximodPaneSummary } from "../../ports/application.js";
import type { MuximodHostPort, MuximodViewportPort, MuximodWorkspaceCatalogPort } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository, WorkspaceRepository } from "../../ports/repositories.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";

export async function createPane(
  input: CreatePaneInput,
  host: MuximodHostPort,
  repository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  viewportManager: MuximodViewportPort,
  workspaceCatalog: MuximodWorkspaceCatalogPort,
  workspaceRepository: WorkspaceRepository,
  agentStatus: AgentStatusStore,
  clock: ApplicationClock,
): Promise<MuximodPaneSummary> {
  const workspace = input.workspaceId
    ? await workspaceCatalog.resolveSelection(
        {
          workspaceId: WorkspaceId.create(input.workspaceId),
          mode: input.useWorktree ? "worktree" : "workspace",
        },
        (id) => workspaceRepository.findById(id),
      )
    : undefined;
  if (!(await host.hasSession(input.sessionName))) {
    throw new ApplicationError("session_not_found", `terminal host session does not exist: ${input.sessionName}`);
  }
  if (input.placement !== "window" && input.workspaceId && !input.useWorktree) {
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

  const cwd = input.placement === "window" ? workspace?.rootPath : undefined;

  const paneName = input.kind === "agent" ? normalizeAgentSessionName(input.name) : input.name;
  const commandInput = paneName === input.name ? input : { ...input, name: paneName };
  const hostPaneId = await host.createManagedPane(commandInput, workspace, cwd);
  await host.setAgentPaneMetadata(hostPaneId, "pane_name", paneName);
  await host.setAgentPaneMetadata(hostPaneId, "kind", input.kind);
  await host.setAgentPaneMetadata(hostPaneId, "agent_id", input.agentId ?? "");
  await host.setAgentPaneMetadata(hostPaneId, "workspace_id", input.workspaceId ?? "");
  if (input.placement !== "window" && input.targetPaneId) {
    await viewportManager.reassertMobileViewport(input.targetPaneId);
  }
  const panes = await reconcilePanes(host, repository, agentSessionRepository, agentStatus, clock);
  const current = panes.find((pane) => pane.hostPaneId === hostPaneId);
  if (!current) {
    throw new ApplicationError("pane_not_visible", "terminal host created the pane but it could not be read");
  }

  const workspaceId = input.workspaceId === undefined ? current.workspaceId : WorkspaceId.create(input.workspaceId);
  let record: MuximodPaneSummary = Pane.update(current, {
    kind: input.kind,
    name: paneName,
    workspaceId,
    agentId: input.agentId ?? clearPatch,
  });
  const desiredState = input.kind === "agent" ? "starting" : "running";
  if (record.state !== desiredState) {
    record = Pane.transitionState(record, desiredState, "pane created", clock.now());
  }
  await repository.upsert(record);
  await host.setAgentPaneMetadata(hostPaneId, "pane_id", record.id);
  await host.setAgentPaneMetadata(hostPaneId, "pane_name", paneName);
  await host.setAgentPaneMetadata(hostPaneId, "agent_id", input.agentId ?? "");
  await host.setAgentPaneMetadata(hostPaneId, "kind", input.kind);
  await host.setAgentPaneMetadata(hostPaneId, "workspace_id", input.workspaceId ?? "");
  return record;
}
