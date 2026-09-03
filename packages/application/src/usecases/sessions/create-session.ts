import { clearPatch, type Pane, WorkspaceId } from "@muximo/domain";
import { Effect, Exit } from "effect";
import { ApplicationClockService } from "../../effect-runtime.js";
import { ApplicationError } from "../../ports/application.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import { MuximodHostService, PaneRepositoryService } from "../terminals/terminal-services.js";
import { MuximodWorkspaceCatalogService, WorkspaceRepositoryService } from "../workspaces/workspace-services.js";
import { summarizeSessions } from "./summarize-sessions.js";

export const createSession = Effect.fn("Sessions.create")(function* (input: { name: string; workspaceId: string }) {
  const clock = yield* ApplicationClockService;
  const host = yield* MuximodHostService;
  const paneRepository = yield* PaneRepositoryService;
  const workspaceCatalog = yield* MuximodWorkspaceCatalogService;
  const workspaceRepository = yield* WorkspaceRepositoryService;
  const workspace = yield* workspaceCatalog.resolveWorkspaceDirectory(WorkspaceId.create(input.workspaceId), (id) =>
    workspaceRepository.findById(id),
  );
  if (yield* host.hasSession(input.name)) {
    return yield* Effect.fail(
      new ApplicationError("session_exists", `terminal host session already exists: ${input.name}`),
    );
  }

  return yield* Effect.acquireUseRelease(
    host.createManagedSession(input.name, workspace.rootPath),
    (managedSessionId) =>
      Effect.gen(function* () {
        const panes = yield* reconcilePanes();
        const initialPane = panes.find((pane) => pane.sessionName === input.name);
        let shellPane: Pane | undefined;
        if (initialPane) {
          shellPane = initialPane.update({
            kind: "shell",
            agentId: clearPatch,
          });
          if (shellPane.state !== "running") {
            shellPane = shellPane.transitionTo("running", "session created", clock.now());
          }
          const paneToPersist = shellPane;
          yield* paneRepository.upsert(paneToPersist);
          yield* host.setAgentPaneMetadata(initialPane.hostPaneId, "kind", "shell");
          yield* host.setAgentPaneMetadata(initialPane.hostPaneId, "agent_id", "");
          yield* host.setAgentPaneMetadata(initialPane.hostPaneId, "managed_session_id", managedSessionId);
        }
        const currentPanes =
          initialPane && shellPane ? panes.map((pane) => (pane.id === initialPane.id ? shellPane : pane)) : panes;
        const session = summarizeSessions(
          currentPanes.filter((pane) => pane.sessionName === input.name),
          new Set([input.name]),
        ).find((candidate) => candidate.name === input.name);
        if (!session || !currentPanes.some((pane) => pane.sessionName === input.name)) {
          return yield* Effect.fail(
            new ApplicationError("session_not_visible", "terminal host created the session but it could not be read"),
          );
        }
        return session;
      }),
    (_managedSessionId, exit) =>
      Exit.isFailure(exit)
        ? host.killSession(input.name).pipe(Effect.catch(() => Effect.succeed(undefined)))
        : Effect.succeed(undefined),
  );
});
