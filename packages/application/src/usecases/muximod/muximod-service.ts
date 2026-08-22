import {
  AgentSessionId,
  type AgentSessionRecord,
  clearPatch,
  normalizeAgentSessionName,
  Pane,
  PaneId,
  type PaneRecord,
  type PaneState,
  paneKindForCommand,
  WorkspaceId,
  type WorkspaceRecord,
} from "@muximo/domain";
import type {
  CreatePaneInput,
  MuximodApplication,
  MuximodPaneSummary,
  MuximodSessionSummary,
  MuximodTerminalEndpoint,
} from "../../ports/application.js";
import { ApplicationError } from "../../ports/application.js";
import type {
  MuximodHostPort,
  MuximodLiveSnapshot,
  MuximodPaneSnapshot,
  MuximodViewportPort,
  MuximodWorkspaceCatalogPort,
} from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository, WorkspaceRepository } from "../../ports/repositories.js";
import {
  type AgentStatusObservation,
  type AgentStatusStore,
  agentStatusKey,
  inferUnmanagedAgentState,
  normalizeAgentStatusObservation,
  readManagedAgentObservation,
} from "../sessions/agent-status.js";
import type { WorkspaceCrud } from "../workspaces/workspace-crud.js";

export type MuximodApplicationResources = {
  getTerminal: () => Promise<MuximodTerminalEndpoint>;
  host: MuximodHostPort;
  paneRepository: PaneRepository;
  agentSessionRepository: AgentSessionRepository;
  workspaceCatalog: MuximodWorkspaceCatalogPort;
  workspaceRepository: WorkspaceRepository;
  workspaceCrud: WorkspaceCrud;
  viewportManager: MuximodViewportPort;
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

export function createMuximodApplication(resources: MuximodApplicationResources): MuximodApplicationRuntime {
  const {
    host,
    paneRepository,
    agentSessionRepository,
    workspaceCatalog,
    viewportManager,
    workspaceRepository,
    workspaceCrud,
  } = resources;
  const agentStatus: AgentStatusStore = new Map();
  return {
    terminal: { get: resources.getTerminal },
    workspaces: {
      list: async () =>
        (await workspaceCrud.list.execute()).map((workspace) => workspaceCatalog.toDirectoryOption(workspace)),
      browse: (parentPath) => workspaceCatalog.browseDirectories(parentPath),
      register: async (input) => {
        const workspace = await workspaceCrud.register.execute({
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
          await workspaceCrud.update.execute(workspaceId, {
            name: input.name,
            setupHook: input.setupScriptPath,
            cleanupHook: input.cleanupScriptPath,
            worktreeCopyPatterns: input.worktreeCopyPatterns,
            appendCopyPatterns: input.appendWorktreeCopyPatterns,
            clearCopyPatterns: input.clearWorktreeCopyPatterns,
          }),
        ),
      delete: async (workspaceId) => {
        await workspaceCrud.delete.execute(workspaceId);
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
    reconcile: (live) => syncPanes(host, paneRepository, agentSessionRepository, live, agentStatus),
    adoptAgentSession: (request) =>
      adoptAgentSession(host, paneRepository, agentSessionRepository, agentStatus, request),
    observeAgentSession: (request) =>
      observeAgentSession(host, paneRepository, agentSessionRepository, agentStatus, request),
    releaseAgentSession: (request) =>
      releaseAgentSession(host, paneRepository, agentSessionRepository, agentStatus, request),
  };
}

async function listSessions(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore,
): Promise<MuximodSessionSummary[]> {
  const panes = await syncPanes(host, paneRepository, agentSessionRepository, undefined, agentStatus);
  return summarizeSessions(panes);
}

async function createSession(
  input: { name: string; initialCwd: string },
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  workspaceCatalog: MuximodWorkspaceCatalogPort,
  agentStatus: AgentStatusStore,
): Promise<MuximodSessionSummary> {
  const cwd = await workspaceCatalog.resolveLegacyDirectory(input.initialCwd);
  if (host.hasSession(input.name)) {
    throw new ApplicationError("session_exists", `tmux session already exists: ${input.name}`);
  }

  let created = false;
  try {
    const managedSessionId = host.createManagedSession(input.name, cwd);
    created = true;
    const panes = await syncPanes(host, paneRepository, agentSessionRepository, undefined, agentStatus);
    const initialPane = panes.find((pane) => pane.sessionName === input.name);
    if (initialPane) {
      const shellPane: PaneRecord = Pane.update(initialPane, {
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

async function listCurrentPanes(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore,
  sessionName?: string,
): Promise<PaneRecord[]> {
  const panes = await syncPanes(host, paneRepository, agentSessionRepository, undefined, agentStatus);
  return sessionName ? panes.filter((pane) => pane.sessionName === sessionName) : panes;
}

async function createPane(
  input: CreatePaneInput,
  host: MuximodHostPort,
  repository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  viewportManager: MuximodViewportPort,
  workspaceCatalog: MuximodWorkspaceCatalogPort,
  agentStatus: AgentStatusStore,
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
  const panes = await syncPanes(host, repository, agentSessionRepository, undefined, agentStatus);
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

async function syncPanes(
  host: MuximodHostPort,
  repository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  live = host.listPanesSnapshot(),
  agentStatus: AgentStatusStore = new Map(),
): Promise<PaneRecord[]> {
  const now = new Date().toISOString();
  const records: PaneRecord[] = [];
  const tmuxServerId = live.tmuxServerId ?? "legacy";

  for (const tmuxPane of live.panes) {
    const paneServerId = tmuxPane.tmuxServerId ?? tmuxServerId;
    const existing = await repository.findByTmuxPaneIdentity(paneServerId, tmuxPane.paneId);
    const sessionCandidate = tmuxPane.muximodSessionId
      ? await agentSessionRepository.findById(AgentSessionId.create(tmuxPane.muximodSessionId))
      : undefined;
    const adoptedSession =
      sessionCandidate &&
      tmuxPane.muximodExecutionId === sessionCandidate.executionId &&
      isLiveAgentExecution(host, sessionCandidate) &&
      host.isManagedMuximoCommand(tmuxPane.command, sessionCandidate.backend)
        ? sessionCandidate
        : undefined;
    const staleAgentMetadata =
      tmuxPane.muximodKind === "agent" && Boolean(tmuxPane.muximodSessionId) && !adoptedSession;
    if (tmuxPane.muximodSessionId && !adoptedSession) {
      if (tmuxPane.muximodExecutionId)
        agentStatus.delete(agentStatusKey(tmuxPane.muximodSessionId, tmuxPane.muximodExecutionId));
      try {
        const cleared = host.clearAgentExecutionMetadata(tmuxPane.paneId, tmuxPane.muximodExecutionId ?? "");
        if (cleared && tmuxPane.muximodKind === "agent") {
          host.resetAgentPaneMetadata(tmuxPane.paneId);
        }
      } catch {
        // The pane may disappear while stale adoption metadata is being cleared.
      }
    }
    const metadataId = tmuxPane.muximodPaneId;
    const metadataPaneId = metadataId ? PaneId.create(metadataId) : undefined;
    const conflictingId = !existing && metadataPaneId ? await repository.findById(metadataPaneId) : undefined;
    const reusableMetadataId =
      metadataPaneId &&
      (!conflictingId || (conflictingId.tmuxServerId === paneServerId && conflictingId.tmuxPaneId === tmuxPane.paneId))
        ? metadataPaneId
        : undefined;
    const kind = resolvePaneKind(tmuxPane, existing, adoptedSession !== undefined, staleAgentMetadata);
    const agentId =
      kind === "agent"
        ? (tmuxPane.muximodAgentId ??
          adoptedSession?.backend ??
          executableName(tmuxPane.command) ??
          existing?.agentId ??
          "agent")
        : undefined;
    const observation: AgentStatusObservation =
      kind !== "agent"
        ? { state: "running" as const }
        : adoptedSession?.executionId
          ? readManagedAgentObservation(adoptedSession.id, adoptedSession.executionId, agentStatus)
          : readUnmanagedAgentObservation(host, tmuxPane, existing?.state ?? "running");
    const name = staleAgentMetadata
      ? tmuxPane.title || tmuxPane.command || tmuxPane.paneId
      : (tmuxPane.muximodName ??
        adoptedSession?.name ??
        (existing?.name && existing.name !== tmuxPane.paneId
          ? existing.name
          : tmuxPane.title || tmuxPane.command || tmuxPane.paneId));
    const record: PaneRecord = Pane.create({
      id: existing?.id ?? reusableMetadataId ?? PaneId.create(`pane-${host.newId()}`),
      tmuxPaneId: tmuxPane.paneId,
      tmuxServerId: paneServerId,
      ...(adoptedSession?.id ? { agentSessionId: adoptedSession.id } : {}),
      ...(adoptedSession?.id && tmuxPane.muximodExecutionId ? { agentExecutionId: tmuxPane.muximodExecutionId } : {}),
      sessionName: tmuxPane.sessionName,
      windowId: tmuxPane.windowId,
      kind,
      name,
      cwd: tmuxPane.cwd,
      ...((existing?.workspaceId ?? adoptedSession?.workspaceId)
        ? { workspaceId: existing?.workspaceId ?? adoptedSession?.workspaceId }
        : {}),
      agentId,
      state: observation.state,
      ...(tmuxPane.title ? { title: tmuxPane.title } : {}),
      ...(observation.recentOutput ? { recentOutput: observation.recentOutput } : {}),
      lastSeenAt: now,
      windowName: tmuxPane.windowName,
      windowIndex: tmuxPane.windowIndex,
      paneIndex: tmuxPane.paneIndex,
      left: tmuxPane.left,
      top: tmuxPane.top,
      width: tmuxPane.width,
      height: tmuxPane.height,
      windowWidth: tmuxPane.windowWidth,
      windowHeight: tmuxPane.windowHeight,
    });
    await repository.upsert(record);
    // Geometry and pane indexes are live tmux state rather than durable
    // identity. Return the live record so the API/UI never loses it during
    // the same reconciliation pass.
    records.push(record);
  }

  return records;
}

async function adoptAgentSession(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore,
  request: { agentSessionId: string; tmuxPaneId: string; executionId: string },
): Promise<void> {
  const session = await agentSessionRepository.findById(AgentSessionId.create(request.agentSessionId));
  if (!session) throw controlFailure("agent_session_not_found", `agent session not found: ${request.agentSessionId}`);
  if (session.executionId !== request.executionId)
    throw controlFailure("agent_execution_mismatch", "agent execution is no longer current");
  const live = host.listPanesSnapshot();
  if (!live.available) throw controlFailure("tmux_unavailable", "tmux is unavailable");
  const pane = live.panes.find((candidate) => candidate.paneId === request.tmuxPaneId);
  if (!pane) throw controlFailure("tmux_pane_not_found", `tmux pane not found: ${request.tmuxPaneId}`);
  host.setAgentExecutionMetadata(pane.paneId, session.id, request.executionId);
  await syncPanes(host, paneRepository, agentSessionRepository, host.listPanesSnapshot(), agentStatus);
}

async function observeAgentSession(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore,
  request: { agentSessionId: string; tmuxPaneId: string; executionId: string; state: PaneState; recentOutput?: string },
): Promise<void> {
  const session = await agentSessionRepository.findById(AgentSessionId.create(request.agentSessionId));
  if (!session) throw controlFailure("agent_session_not_found", `agent session not found: ${request.agentSessionId}`);
  if (session.executionId !== request.executionId)
    throw controlFailure("agent_execution_mismatch", "agent execution is no longer current");
  const live = host.listPanesSnapshot();
  if (!live.available) throw controlFailure("tmux_unavailable", "tmux is unavailable");
  const pane = live.panes.find((candidate) => candidate.paneId === request.tmuxPaneId);
  if (!pane) throw controlFailure("tmux_pane_not_found", `tmux pane not found: ${request.tmuxPaneId}`);
  if (pane.muximodSessionId !== request.agentSessionId || pane.muximodExecutionId !== request.executionId) {
    throw controlFailure("agent_execution_not_adopted", "agent execution is not associated with the requested pane");
  }
  const key = agentStatusKey(request.agentSessionId, request.executionId);
  const previous = agentStatus.get(key);
  agentStatus.set(
    key,
    normalizeAgentStatusObservation({
      state: request.state,
      recentOutput: request.recentOutput ?? previous?.recentOutput,
    }),
  );
  await syncPanes(host, paneRepository, agentSessionRepository, live, agentStatus);
}

async function releaseAgentSession(
  host: MuximodHostPort,
  paneRepository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore,
  request: { agentSessionId: string; tmuxPaneId: string; executionId: string },
): Promise<void> {
  const live = host.listPanesSnapshot();
  if (!live.available) return;
  const pane = live.panes.find((candidate) => candidate.paneId === request.tmuxPaneId);
  if (!pane) return;
  if (pane.muximodSessionId === request.agentSessionId && pane.muximodExecutionId === request.executionId) {
    agentStatus.delete(agentStatusKey(request.agentSessionId, request.executionId));
    if (!host.clearAgentExecutionMetadata(pane.paneId, request.executionId)) return;
    host.resetAgentPaneMetadata(pane.paneId);
    await syncPanes(host, paneRepository, agentSessionRepository, host.listPanesSnapshot(), agentStatus);
  }
}

function controlFailure(code: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function summarizeSessions(panes: PaneRecord[]): MuximodSessionSummary[] {
  const groups = new Map<string, PaneRecord[]>();
  for (const pane of panes) groups.set(pane.sessionName, [...(groups.get(pane.sessionName) ?? []), pane]);

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, sessionPanes]) => {
      const agents = sessionPanes.filter((pane) => pane.kind === "agent").length;
      const shells = sessionPanes.filter((pane) => pane.kind === "shell").length;
      const waitingCount = sessionPanes.filter(
        (pane) => pane.state === "waiting_input" || pane.state === "waiting_approval",
      ).length;
      const detailParts = [`${agents} agent${agents === 1 ? "" : "s"}`, `${shells} shell${shells === 1 ? "" : "s"}`];
      if (waitingCount) detailParts.push(`${waitingCount} waiting`);
      return {
        name,
        paneCount: sessionPanes.length,
        waitingCount,
        detail: detailParts.join(" · "),
      } satisfies MuximodSessionSummary;
    });
}

function resolvePaneKind(
  tmuxPane: MuximodPaneSnapshot,
  existing: PaneRecord | undefined,
  adopted: boolean,
  staleAgentMetadata: boolean,
): PaneRecord["kind"] {
  if (staleAgentMetadata) return "shell";
  if (tmuxPane.muximodKind === "agent" && adopted) return "agent";
  if (tmuxPane.muximodKind === "agent" && !tmuxPane.muximodSessionId) return "agent";
  if (tmuxPane.muximodKind === "shell" || tmuxPane.muximodKind === "unknown") return tmuxPane.muximodKind;
  const detected = paneKindForCommand(tmuxPane.command);
  if (detected === "unknown" && existing?.kind === "agent" && adopted) return "agent";
  return detected;
}

function readUnmanagedAgentObservation(
  host: MuximodHostPort,
  pane: MuximodPaneSnapshot,
  fallback: PaneState,
): AgentStatusObservation {
  try {
    return { state: inferUnmanagedAgentState(host.capturePane(pane.paneId), fallback) };
  } catch {
    return { state: fallback };
  }
}

function executableName(command: string): string | null {
  const executable = command.trim().split(/\s+/, 1)[0]?.split("/").at(-1)?.toLowerCase();
  return executable === "codex" || executable === "claude" || executable === "opencode" ? executable : null;
}

function isLiveAgentExecution(
  host: MuximodHostPort,
  session: Pick<AgentSessionRecord, "status" | "executionPid">,
): boolean {
  if (session.status !== "running" && session.status !== "resuming") return false;
  if (session.executionPid === undefined) return false;
  return host.isProcessAlive(session.executionPid);
}
