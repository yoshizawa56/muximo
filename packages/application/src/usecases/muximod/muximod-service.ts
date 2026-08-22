import { type PaneRecord, type PaneState, WorkspaceId } from "@muximo/domain";
import type { MuximodApplication, MuximodTerminalEndpoint } from "../../ports/application.js";
import type {
  MuximodHostPort,
  MuximodLiveSnapshot,
  MuximodViewportPort,
  MuximodWorkspaceCatalogPort,
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
import { reconcilePanes } from "../terminals/reconcile-panes.js";
import type { DeleteWorkspace } from "../workspaces/delete-workspace.js";
import type { ListWorkspaces } from "../workspaces/list-workspaces.js";
import type { RegisterWorkspace } from "../workspaces/register-workspace.js";
import type { UpdateWorkspace } from "../workspaces/update-workspace.js";

export type MuximodApplicationResources = {
  getTerminal: () => Promise<MuximodTerminalEndpoint>;
  host: MuximodHostPort;
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
  reconcile(live?: MuximodLiveSnapshot): Promise<PaneRecord[]>;
  adoptAgentSession(request: { agentSessionId: string; tmuxPaneId: string; executionId: string }): Promise<void>;
  observeAgentSession(request: {
    agentSessionId: string;
    tmuxPaneId: string;
    executionId: string;
    state: PaneState;
    recentOutput?: string;
  }): Promise<void>;
  releaseAgentSession(request: { agentSessionId: string; tmuxPaneId: string; executionId: string }): Promise<void>;
};

/**
 * Pure assembler: wires the individual use cases into the transport-neutral
 * application facade consumed by HTTP and CLI adapters.
 */
export function createMuximodApplication(resources: MuximodApplicationResources): MuximodApplicationRuntime {
  const {
    host,
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
      resolveDirectory: (workspaceId) =>
        workspaceCatalog.resolveWorkspaceDirectory(WorkspaceId.create(workspaceId), (id) =>
          workspaceRepository.findById(id),
        ),
      resolveSelection: (selection) =>
        workspaceCatalog.resolveSelection(
          { workspaceId: WorkspaceId.create(selection.workspaceId), mode: selection.mode },
          (id) => workspaceRepository.findById(id),
        ),
    },
    sessions: {
      list: () => listSessions(host, paneRepository, agentSessionRepository, agentStatus),
      create: (input) =>
        createSession(input, host, paneRepository, agentSessionRepository, workspaceCatalog, agentStatus),
    },
    panes: {
      list: (sessionName) => listCurrentPanes(host, paneRepository, agentSessionRepository, agentStatus, sessionName),
      create: (input, workspace) =>
        createPane(
          input,
          host,
          paneRepository,
          agentSessionRepository,
          viewportManager,
          workspaceCatalog,
          agentStatus,
          workspace,
        ),
    },
    hooks: { handleTmux: (event, client) => viewportManager.handleTmuxHook(event, client) },
    reconcile: (live) => reconcilePanes(host, paneRepository, agentSessionRepository, live, agentStatus),
    adoptAgentSession: (request) =>
      adoptAgentSession(host, paneRepository, agentSessionRepository, agentStatus, request),
    observeAgentSession: (request) =>
      observeAgentSession(host, paneRepository, agentSessionRepository, agentStatus, request),
    releaseAgentSession: (request) =>
      releaseAgentSession(host, paneRepository, agentSessionRepository, agentStatus, request),
  };
}
