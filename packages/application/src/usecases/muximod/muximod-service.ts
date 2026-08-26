import type { PaneRecord, PaneState } from "@muximo/domain";
import type { ApplicationClock, MuximodApplication, MuximodTerminalEndpoint } from "../../ports/application.js";
import type {
  MuximodHostPort,
  MuximodSessionManagementPort,
  MuximodViewportPort,
  MuximodWorkspaceCatalogPort,
  TerminalHostSnapshot,
} from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository, WorkspaceRepository } from "../../ports/repositories.js";
import { adoptAgentSession } from "../agents/adopt-agent-session.js";
import { observeAgentSession } from "../agents/observe-agent-session.js";
import { releaseAgentSession } from "../agents/release-agent-session.js";
import { createPane } from "../panes/create-pane.js";
import { listCurrentPanes } from "../panes/list-current-panes.js";
import type { AgentStatusStore } from "../sessions/agent-status.js";
import { createSession } from "../sessions/create-session.js";
import { listSessions } from "../sessions/list-sessions.js";
import { manageSession } from "../sessions/manage-session.js";
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import type { DeleteWorkspace } from "../workspaces/delete-workspace.js";
import type { ListWorkspaces } from "../workspaces/list-workspaces.js";
import type { RegisterWorkspace } from "../workspaces/register-workspace.js";
import type { UpdateWorkspace } from "../workspaces/update-workspace.js";

export type MuximodApplicationResources = {
  getTerminal: () => Promise<MuximodTerminalEndpoint>;
  host: MuximodHostPort;
  sessionManagement: MuximodSessionManagementPort;
  clock: ApplicationClock;
  paneRepository: PaneRepository;
  agentSessionRepository: AgentSessionRepository;
  workspaceCatalog: MuximodWorkspaceCatalogPort;
  workspaceRepository: WorkspaceRepository;
  listWorkspaces: ListWorkspaces;
  registerWorkspace: RegisterWorkspace;
  updateWorkspace: UpdateWorkspace;
  deleteWorkspace: DeleteWorkspace;
  viewportManager: MuximodViewportPort;
  /** In-process agent observation state; owned by the composition root. */
  agentStatus: AgentStatusStore;
};

export type MuximodApplicationRuntime = MuximodApplication & {
  reconcile(live?: TerminalHostSnapshot): Promise<PaneRecord[]>;
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
  const {
    host,
    sessionManagement,
    clock,
    paneRepository,
    agentSessionRepository,
    workspaceCatalog,
    viewportManager,
    workspaceRepository,
    listWorkspaces,
    registerWorkspace,
    updateWorkspace,
    deleteWorkspace,
    agentStatus,
  } = resources;
  return {
    terminal: { get: resources.getTerminal },
    workspaces: {
      list: async () =>
        (await listWorkspaces.execute()).map((workspace) => workspaceCatalog.toDirectoryOption(workspace)),
      browse: (parentPath) => workspaceCatalog.browseDirectories(parentPath),
      register: async (input) => {
        const workspace = await registerWorkspace.execute({
          directory: input.directory,
          name: input.name,
          setupHook: input.setupScriptPath,
          cleanupHook: input.cleanupScriptPath,
          worktreeCopyPatterns: input.worktreeCopyPatterns,
        });
        return workspaceCatalog.toDirectoryOption(workspace);
      },
      update: async (workspaceId, input) =>
        workspaceCatalog.toDirectoryOption(
          await updateWorkspace.execute(workspaceId, {
            name: input.name,
            setupHook: input.setupScriptPath,
            cleanupHook: input.cleanupScriptPath,
            worktreeCopyPatterns: input.worktreeCopyPatterns,
            appendCopyPatterns: input.appendWorktreeCopyPatterns,
            clearCopyPatterns: input.clearWorktreeCopyPatterns,
          }),
        ),
      delete: async (workspaceId) => {
        await deleteWorkspace.execute(workspaceId);
      },
    },
    sessions: {
      list: () => listSessions(host, paneRepository, agentSessionRepository, agentStatus, clock),
      create: (input) =>
        createSession(
          input,
          host,
          paneRepository,
          agentSessionRepository,
          workspaceCatalog,
          workspaceRepository,
          agentStatus,
          clock,
        ),
      manage: (input) => manageSession(input, sessionManagement),
    },
    panes: {
      list: (sessionName) =>
        listCurrentPanes(host, paneRepository, agentSessionRepository, agentStatus, clock, sessionName),
      create: (input) =>
        createPane(
          input,
          host,
          paneRepository,
          agentSessionRepository,
          viewportManager,
          workspaceCatalog,
          workspaceRepository,
          agentStatus,
          clock,
        ),
    },
    hooks: {
      handleTerminalHostHook: async (event, client) => {
        await viewportManager.handleTerminalHostHook(event, client);
      },
    },
    reconcile: (live) => reconcilePanes(host, paneRepository, agentSessionRepository, agentStatus, clock, live),
    adoptAgentSession: (request) =>
      adoptAgentSession(host, paneRepository, agentSessionRepository, agentStatus, clock, request),
    observeAgentSession: (request) =>
      observeAgentSession(host, paneRepository, agentSessionRepository, agentStatus, clock, request),
    releaseAgentSession: (request) =>
      releaseAgentSession(host, paneRepository, agentSessionRepository, agentStatus, clock, request),
  };
}
