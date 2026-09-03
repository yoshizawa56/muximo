import { clearPatch, normalizeAgentSessionName, WorkspaceId } from "@muximo/domain";
import { Effect } from "effect";
import { attemptSync } from "../../attempt.js";
import { ApplicationClockService } from "../../effect-runtime.js";
import type { CreatePaneInput } from "../../ports/application.js";
import { ApplicationError, type MuximodPaneSummary } from "../../ports/application.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import { MuximodHostService, MuximodViewportService, PaneRepositoryService } from "../terminals/terminal-services.js";
import { MuximodWorkspaceCatalogService, WorkspaceRepositoryService } from "../workspaces/workspace-services.js";

export const createPane = Effect.fn("Panes.create")(function* (input: CreatePaneInput) {
  const clock = yield* ApplicationClockService;
  const host = yield* MuximodHostService;
  const repository = yield* PaneRepositoryService;
  const viewportManager = yield* MuximodViewportService;
  const workspaceCatalog = yield* MuximodWorkspaceCatalogService;
  const workspaceRepository = yield* WorkspaceRepositoryService;
  const workspaceId = input.workspaceId;
  const workspace = workspaceId
    ? yield* workspaceCatalog.resolveSelection(
        {
          workspaceId: yield* attemptSync(() => WorkspaceId.create(workspaceId)),
          mode: input.useWorktree ? "worktree" : "workspace",
        },
        (id) => workspaceRepository.findById(id),
      )
    : undefined;
  if (!(yield* host.hasSession(input.sessionName))) {
    return yield* Effect.fail(
      new ApplicationError("session_not_found", `terminal host session does not exist: ${input.sessionName}`),
    );
  }
  if (input.placement !== "window" && input.workspaceId && !input.useWorktree) {
    return yield* Effect.fail(
      new ApplicationError("split_directory_override_unsupported", "Split panes always inherit the target pane cwd"),
    );
  }
  if (input.kind === "agent" && !input.agentId) {
    return yield* Effect.fail(new ApplicationError("agent_required", "agentId is required for an agent pane"));
  }
  if (input.kind === "shell" && input.agentId) {
    return yield* Effect.fail(new ApplicationError("agent_not_allowed", "agentId is not allowed for a shell pane"));
  }

  const cwd = input.placement === "window" ? workspace?.rootPath : undefined;

  const paneName =
    input.kind === "agent" ? yield* attemptSync(() => normalizeAgentSessionName(input.name)) : input.name;
  const commandInput = paneName === input.name ? input : { ...input, name: paneName };
  const hostPaneId = yield* host.createManagedPane(commandInput, workspace, cwd);
  yield* host.setAgentPaneMetadata(hostPaneId, "pane_name", paneName);
  yield* host.setAgentPaneMetadata(hostPaneId, "kind", input.kind);
  yield* host.setAgentPaneMetadata(hostPaneId, "agent_id", input.agentId ?? "");
  yield* host.setAgentPaneMetadata(hostPaneId, "workspace_id", input.workspaceId ?? "");
  const targetPaneId = input.targetPaneId;
  if (input.placement !== "window" && targetPaneId) {
    yield* viewportManager.reassertMobileViewport(targetPaneId);
  }
  const panes = yield* reconcilePanes();
  const current = panes.find((pane) => pane.hostPaneId === hostPaneId);
  if (!current) {
    return yield* Effect.fail(
      new ApplicationError("pane_not_visible", "terminal host created the pane but it could not be read"),
    );
  }

  const recordWorkspaceId =
    workspaceId === undefined ? current.workspaceId : yield* attemptSync(() => WorkspaceId.create(workspaceId));
  let record: MuximodPaneSummary = yield* attemptSync(() =>
    current.update({
      kind: input.kind,
      name: paneName,
      workspaceId: recordWorkspaceId,
      agentId: input.agentId ?? clearPatch,
    }),
  );
  const desiredState = input.kind === "agent" ? "starting" : "running";
  if (record.state !== desiredState) {
    record = yield* attemptSync(() => record.transitionTo(desiredState, "pane created", clock.now()));
  }
  yield* repository.upsert(record);
  yield* host.setAgentPaneMetadata(hostPaneId, "pane_id", record.id);
  yield* host.setAgentPaneMetadata(hostPaneId, "pane_name", paneName);
  yield* host.setAgentPaneMetadata(hostPaneId, "agent_id", input.agentId ?? "");
  yield* host.setAgentPaneMetadata(hostPaneId, "kind", input.kind);
  yield* host.setAgentPaneMetadata(hostPaneId, "workspace_id", input.workspaceId ?? "");
  return record;
});
