import {
  AgentSessionId,
  type AgentSessionRecord,
  clearPatch,
  Pane,
  type PaneCreateInput,
  PaneId,
  type PaneRecord,
} from "@muximo/domain";
import type { MuximodClock } from "../../ports/application.js";
import type {
  HostPaneSnapshot,
  MuximodHostPort,
  MuximodPaneClassification,
  TerminalHostSnapshot,
} from "../../ports/host.js";
import type { AgentSessionRepository, PaneRepository } from "../../ports/repositories.js";
import {
  type AgentStatusObservation,
  type AgentStatusStore,
  agentStatusKey,
  readManagedAgentObservation,
} from "../sessions/agent-status.js";

/**
 * Reconciles live terminal-host pane snapshots with persisted pane records.
 * This is the single write path that turns host observations into durable pane state.
 */
export async function reconcilePanes(
  host: MuximodHostPort,
  repository: PaneRepository,
  agentSessionRepository: AgentSessionRepository,
  agentStatus: AgentStatusStore,
  clock: MuximodClock,
  live?: TerminalHostSnapshot,
): Promise<PaneRecord[]> {
  const snapshot = live ?? (await host.listPanesSnapshot());
  const now = clock.now();
  const records: PaneRecord[] = [];
  const hostServerId = snapshot.hostServerId ?? "legacy";

  for (const hostPane of snapshot.panes) {
    const paneHostServerId = hostPane.hostServerId ?? hostServerId;
    const existing = await repository.findByHostPaneIdentity(paneHostServerId, hostPane.hostPaneId);
    const sessionCandidate = hostPane.muximodSessionId
      ? await agentSessionRepository.findById(AgentSessionId.create(hostPane.muximodSessionId))
      : undefined;
    const adoptedSession =
      sessionCandidate &&
      hostPane.muximodExecutionId === sessionCandidate.executionId &&
      (await isLiveAgentExecution(host, sessionCandidate)) &&
      (await host.isManagedAgentExecution(hostPane.command, sessionCandidate.backend))
        ? sessionCandidate
        : undefined;
    const staleAgentMetadata =
      hostPane.muximodKind === "agent" && Boolean(hostPane.muximodSessionId) && !adoptedSession;
    if (hostPane.muximodSessionId && !adoptedSession) {
      if (hostPane.muximodExecutionId)
        agentStatus.delete(agentStatusKey(hostPane.muximodSessionId, hostPane.muximodExecutionId));
      try {
        const cleared = await host.clearAgentExecutionMetadata(hostPane.hostPaneId, hostPane.muximodExecutionId ?? "");
        if (cleared && hostPane.muximodKind === "agent") {
          await host.resetAgentPaneMetadata(hostPane.hostPaneId);
        }
      } catch {
        // The pane may disappear while stale adoption metadata is being cleared.
      }
    }
    const metadataId = hostPane.muximodPaneId;
    const metadataPaneId = metadataId ? PaneId.create(metadataId) : undefined;
    const conflictingId = !existing && metadataPaneId ? await repository.findById(metadataPaneId) : undefined;
    const reusableMetadataId =
      metadataPaneId &&
      (!conflictingId ||
        (conflictingId.hostServerId === paneHostServerId && conflictingId.hostPaneId === hostPane.hostPaneId))
        ? metadataPaneId
        : undefined;
    const commandObservation = await host.classifyCommand(hostPane.command);
    const kind = resolvePaneKind(
      hostPane,
      existing,
      adoptedSession !== undefined,
      staleAgentMetadata,
      commandObservation,
    );
    const agentId =
      kind === "agent"
        ? (hostPane.muximodAgentId ??
          adoptedSession?.backend ??
          commandObservation.agentId ??
          existing?.agentId ??
          "agent")
        : undefined;
    const observation: AgentStatusObservation =
      kind !== "agent"
        ? { state: "running" as const }
        : adoptedSession?.executionId
          ? readManagedAgentObservation(adoptedSession.id, adoptedSession.executionId, agentStatus)
          : await host.observeUnmanagedAgent(hostPane.hostPaneId, existing?.state ?? "running");
    const name = staleAgentMetadata
      ? hostPane.title || hostPane.command || hostPane.hostPaneId
      : (hostPane.muximodName ??
        adoptedSession?.name ??
        (existing?.name && existing.name !== hostPane.hostPaneId
          ? existing.name
          : hostPane.title || hostPane.command || hostPane.hostPaneId));
    const id = existing?.id ?? reusableMetadataId ?? PaneId.create(`pane-${host.newId()}`);
    const workspaceId = existing?.workspaceId ?? adoptedSession?.workspaceId;
    const agentExecutionId =
      adoptedSession?.id && hostPane.muximodExecutionId ? hostPane.muximodExecutionId : undefined;
    const initialState = kind === "agent" && !existing ? "starting" : observation.state;
    const createInput: PaneCreateInput = {
      id,
      hostPaneId: hostPane.hostPaneId,
      hostServerId: paneHostServerId,
      ...(adoptedSession?.id ? { agentSessionId: adoptedSession.id } : {}),
      ...(agentExecutionId ? { agentExecutionId } : {}),
      sessionName: hostPane.sessionName,
      windowId: hostPane.windowId,
      kind,
      name,
      cwd: hostPane.cwd,
      ...(workspaceId ? { workspaceId } : {}),
      ...(kind === "agent" ? { agentId } : {}),
      initialState,
      ...(hostPane.title ? { title: hostPane.title } : {}),
      ...(observation.recentOutput ? { recentOutput: observation.recentOutput } : {}),
      lastSeenAt: now,
      windowName: hostPane.windowName,
      windowIndex: hostPane.windowIndex,
      paneIndex: hostPane.paneIndex,
      left: hostPane.left,
      top: hostPane.top,
      width: hostPane.width,
      height: hostPane.height,
      windowWidth: hostPane.windowWidth,
      windowHeight: hostPane.windowHeight,
    };
    let record: PaneRecord;
    if (!existing) {
      record = Pane.create(createInput);
    } else {
      record = Pane.update(existing, {
        agentSessionId: adoptedSession?.id ?? clearPatch,
        agentExecutionId: agentExecutionId ?? clearPatch,
        sessionName: hostPane.sessionName,
        windowId: hostPane.windowId,
        kind,
        name,
        cwd: hostPane.cwd,
        workspaceId: workspaceId ?? clearPatch,
        agentId: kind === "agent" ? agentId : clearPatch,
        title: hostPane.title ? hostPane.title : clearPatch,
        recentOutput: observation.recentOutput ?? clearPatch,
        lastSeenAt: now,
        windowName: hostPane.windowName,
        windowIndex: hostPane.windowIndex,
        paneIndex: hostPane.paneIndex,
        left: hostPane.left,
        top: hostPane.top,
        width: hostPane.width,
        height: hostPane.height,
        windowWidth: hostPane.windowWidth,
        windowHeight: hostPane.windowHeight,
      });
      if (record.state !== observation.state) {
        record = Pane.transitionState(record, observation.state, "terminal observation", now);
      }
    }
    await repository.upsert(record);
    // Geometry and pane indexes are live host state rather than durable identity.
    // Return the live record so the API/UI never loses it during reconciliation.
    records.push(record);
  }

  return records;
}

function resolvePaneKind(
  hostPane: HostPaneSnapshot,
  existing: PaneRecord | undefined,
  adopted: boolean,
  staleAgentMetadata: boolean,
  commandObservation: MuximodPaneClassification,
): PaneRecord["kind"] {
  if (staleAgentMetadata) return "shell";
  if (hostPane.muximodKind === "agent" && adopted) return "agent";
  if (hostPane.muximodKind === "agent" && !hostPane.muximodSessionId) return "agent";
  if (hostPane.muximodKind === "shell" || hostPane.muximodKind === "unknown") return hostPane.muximodKind;
  const detected = commandObservation.kind;
  if (detected === "unknown" && existing?.kind === "agent" && adopted) return "agent";
  return detected;
}

async function isLiveAgentExecution(
  host: MuximodHostPort,
  session: Pick<AgentSessionRecord, "status" | "executionPid">,
): Promise<boolean> {
  if (session.status !== "running" && session.status !== "resuming") return false;
  if (session.executionPid === undefined) return false;
  return await host.isProcessAlive(session.executionPid);
}
