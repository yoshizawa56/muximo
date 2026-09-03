import type { Pane, PaneState } from "@muximo/domain";
import { Effect, Layer } from "effect";
import { type ApplicationClockService, applicationClockLayer } from "../../effect-runtime.js";
import type {
  ApplicationClock,
  MuximodAgentSessionApplication,
  MuximodApplication,
  MuximodTerminalEndpoint,
} from "../../ports/application.js";
import type { MuximodWorkspaceCatalogPort, TerminalHostSnapshot } from "../../ports/host.js";
import { adoptAgentSession } from "../agents/adopt-agent-session.js";
import { observeAgentSession } from "../agents/observe-agent-session.js";
import { releaseAgentSession } from "../agents/release-agent-session.js";
import { createPane } from "../panes/create-pane.js";
import { listCurrentPanes } from "../panes/list-current-panes.js";
import { createSession } from "../sessions/create-session.js";
import { listSessions } from "../sessions/list-sessions.js";
import { manageSession } from "../sessions/manage-session.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import type { TerminalServices } from "../terminals/terminal-services.js";
import { MuximodViewportService } from "../terminals/terminal-services.js";
import { deleteWorkspace } from "../workspaces/delete-workspace.js";
import { listWorkspaces } from "../workspaces/list-workspaces.js";
import { registerWorkspace } from "../workspaces/register-workspace.js";
import { updateWorkspace } from "../workspaces/update-workspace.js";
import type { WorkspaceServices } from "../workspaces/workspace-services.js";

export type MuximodApplicationResources = {
  agentSessions: MuximodAgentSessionApplication;
  getTerminal: () => Promise<MuximodTerminalEndpoint>;
  clock: ApplicationClock;
  workspaceCatalog: MuximodWorkspaceCatalogPort;
  workspaceLayer: Layer.Layer<WorkspaceServices>;
  terminalLayer: Layer.Layer<TerminalServices>;
};

export type MuximodApplicationRuntime = MuximodApplication & {
  reconcile(live?: TerminalHostSnapshot): Promise<Pane[]>;
  adoptAgentSession(request: { agentSessionId: string; hostPaneId: string; executionId: string }): Promise<void>;
  observeAgentSession(request: {
    agentSessionId: string;
    hostPaneId: string;
    executionId: string;
    state: PaneState;
    recentOutput?: string;
  }): Promise<void>;
  releaseAgentSession(request: { agentSessionId: string; hostPaneId: string; executionId: string }): Promise<void>;
};

/**
 * Pure assembler: wires the individual use cases into the transport-neutral
 * application facade consumed by HTTP and CLI adapters.
 */
export function createMuximodApplication(resources: MuximodApplicationResources): MuximodApplicationRuntime {
  const { clock, workspaceCatalog, workspaceLayer, terminalLayer } = resources;
  return {
    agentSessions: resources.agentSessions,
    terminal: { get: resources.getTerminal },
    workspaces: {
      list: async () =>
        (await runWorkspaceEffect(listWorkspaces(), clock, workspaceLayer)).map((workspace) =>
          workspaceCatalog.toDirectoryOption(workspace),
        ),
      browse: (parentPath) => runEffect(workspaceCatalog.browseDirectories(parentPath)),
      register: async (input) => {
        const workspace = await runWorkspaceEffect(
          registerWorkspace({
            directory: input.directory,
            name: input.name,
            setupHook: input.setupScriptPath,
            cleanupHook: input.cleanupScriptPath,
          }),
          clock,
          workspaceLayer,
        );
        return workspaceCatalog.toDirectoryOption(workspace);
      },
      update: async (workspaceId, input) =>
        workspaceCatalog.toDirectoryOption(
          await runWorkspaceEffect(
            updateWorkspace(workspaceId, {
              name: input.name,
              setupHook: input.setupScriptPath,
              cleanupHook: input.cleanupScriptPath,
            }),
            clock,
            workspaceLayer,
          ),
        ),
      delete: async (workspaceId) => {
        await runWorkspaceEffect(deleteWorkspace(workspaceId), clock, workspaceLayer);
      },
    },
    sessions: {
      list: () => runTerminalEffect(listSessions(), clock, workspaceLayer, terminalLayer),
      create: (input) => runTerminalEffect(createSession(input), clock, workspaceLayer, terminalLayer),
      manage: (input) => runTerminalEffect(manageSession(input), clock, workspaceLayer, terminalLayer),
    },
    panes: {
      list: (sessionName) => runTerminalEffect(listCurrentPanes(sessionName), clock, workspaceLayer, terminalLayer),
      create: (input) => runTerminalEffect(createPane(input), clock, workspaceLayer, terminalLayer),
    },
    hooks: {
      handleTerminalHostHook: (event, client) =>
        runTerminalEffect(
          Effect.gen(function* () {
            const viewport = yield* MuximodViewportService;
            yield* viewport.handleTerminalHostHook(event, client);
          }),
          clock,
          workspaceLayer,
          terminalLayer,
        ),
    },
    reconcile: (live) => runTerminalEffect(reconcilePanes(live), clock, workspaceLayer, terminalLayer),
    adoptAgentSession: (request) => runTerminalEffect(adoptAgentSession(request), clock, workspaceLayer, terminalLayer),
    observeAgentSession: (request) =>
      runTerminalEffect(observeAgentSession(request), clock, workspaceLayer, terminalLayer),
    releaseAgentSession: (request) =>
      runTerminalEffect(releaseAgentSession(request), clock, workspaceLayer, terminalLayer),
  };
}

function runEffect<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(effect);
}

function runWorkspaceEffect<A, E>(
  effect: Effect.Effect<A, E, WorkspaceServices | ApplicationClockService>,
  clock: ApplicationClock,
  workspaceLayer: Layer.Layer<WorkspaceServices>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(workspaceLayer, applicationClockLayer(clock)))));
}

function runTerminalEffect<A, E>(
  effect: Effect.Effect<A, E, TerminalServices | WorkspaceServices | ApplicationClockService>,
  clock: ApplicationClock,
  workspaceLayer: Layer.Layer<WorkspaceServices>,
  terminalLayer: Layer.Layer<TerminalServices>,
): Promise<A> {
  return Effect.runPromise(
    effect.pipe(Effect.provide(Layer.mergeAll(workspaceLayer, terminalLayer, applicationClockLayer(clock)))),
  );
}
