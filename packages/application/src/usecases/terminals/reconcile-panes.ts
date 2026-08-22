import {
  AgentSessionId,
  type AgentSessionRecord,
  Pane,
  PaneId,
  type PaneRecord,
  type PaneState,
  paneKindForCommand,
} from "@muximo/domain";
import type { MuximodHostPort, MuximodLiveSnapshot, MuximodPaneSnapshot } from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import {
  type AgentStatusObservation,
  type AgentStatusStore,
  agentStatusKey,
  inferUnmanagedAgentState,
  readManagedAgentObservation,
} from "../sessions/agent-status.js";

/**
 * Reconciles live tmux pane snapshots with persisted pane records. This is the
 * single write path that turns host observations into durable pane state.
 */
export async function reconcilePanes(
  host: MuximodHostPort,
  repository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  live?: MuximodLiveSnapshot,
  agentStatus: AgentStatusStore = new Map(),
): Promise<PaneRecord[]> {
  const snapshot = live ?? host.listPanesSnapshot();
  const now = new Date().toISOString();
  const records: PaneRecord[] = [];
  const tmuxServerId = snapshot.tmuxServerId ?? "legacy";

  for (const tmuxPane of snapshot.panes) {
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
