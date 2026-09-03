import { type AgentSession, AgentSessionId, clearPatch, Pane, type PaneCreateInput, PaneId } from "@muximo/domain";
import { Effect } from "effect";
import { attemptSync } from "../../attempt.js";
import { ApplicationClockService } from "../../effect-runtime.js";
import { ApplicationError } from "../../ports/application.js";
import type { HostPaneSnapshot, MuximodPaneClassification, TerminalHostSnapshot } from "../../ports/host.js";
import { type AgentStatusObservation, agentStatusKey, readManagedAgentObservation } from "../sessions/agent-status.js";
import {
  AgentSessionRepositoryService,
  AgentStatusService,
  MuximodHostService,
  PaneRepositoryService,
} from "./terminal-services.js";

/**
 * Reconciles live terminal-host pane snapshots with persisted pane records.
 * This is the single write path that turns host observations into durable pane state.
 */
export const reconcilePanes = Effect.fn("Terminals.reconcilePanes")(function* (live?: TerminalHostSnapshot) {
  const host = yield* MuximodHostService;
  const repository = yield* PaneRepositoryService;
  const agentSessionRepository = yield* AgentSessionRepositoryService;
  const agentStatus = yield* AgentStatusService;
  const clock = yield* ApplicationClockService;
  const snapshot = live ?? (yield* host.listPanesSnapshot());
  const now = clock.now();
  const records: Pane[] = [];
  if (snapshot.panes.length > 0 && !snapshot.hostServerId) {
    return yield* Effect.fail(new ApplicationError("terminal_host_unavailable", "tmux server identity is unavailable"));
  }

  for (const hostPane of snapshot.panes) {
    const paneHostServerId = hostPane.hostServerId;
    const existing = yield* repository.findByHostPaneIdentity(paneHostServerId, hostPane.hostPaneId);
    const rawMuximodSessionId = hostPane.muximodSessionId;
    const muximodSessionId = rawMuximodSessionId
      ? yield* attemptSync(() => AgentSessionId.create(rawMuximodSessionId))
      : undefined;
    const sessionCandidate = muximodSessionId ? yield* agentSessionRepository.findById(muximodSessionId) : undefined;
    // Adoption writes execution metadata before the backend process is spawned, so the pane command is still the
    // caller's shell. The session/execution identity and its live owner process are the authoritative checks here.
    const adoptedSession =
      sessionCandidate &&
      hostPane.muximodExecutionId === sessionCandidate.executionId &&
      (yield* isLiveAgentExecution(sessionCandidate))
        ? sessionCandidate
        : undefined;
    const staleAgentMetadata =
      hostPane.muximodKind === "agent" && Boolean(hostPane.muximodSessionId) && !adoptedSession;
    if (hostPane.muximodSessionId && !adoptedSession) {
      if (hostPane.muximodExecutionId)
        agentStatus.delete(agentStatusKey(hostPane.muximodSessionId, hostPane.muximodExecutionId));
      yield* Effect.catch(
        Effect.gen(function* () {
          const cleared = yield* host.clearAgentExecutionMetadata(
            hostPane.hostPaneId,
            hostPane.muximodExecutionId ?? "",
          );
          if (cleared && hostPane.muximodKind === "agent") {
            yield* host.resetAgentPaneMetadata(hostPane.hostPaneId);
          }
        }),
        // The pane may disappear while stale adoption metadata is being cleared.
        () => Effect.succeed(undefined),
      );
    }
    const metadataId = hostPane.muximodPaneId;
    const metadataPaneId = metadataId ? yield* attemptSync(() => PaneId.create(metadataId)) : undefined;
    const conflictingId = !existing && metadataPaneId ? yield* repository.findById(metadataPaneId) : undefined;
    const reusableMetadataId =
      metadataPaneId &&
      (!conflictingId ||
        (conflictingId.hostServerId === paneHostServerId && conflictingId.hostPaneId === hostPane.hostPaneId))
        ? metadataPaneId
        : undefined;
    const commandObservation = yield* host.classifyCommand(hostPane.command);
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
          ? readManagedAgentObservation(
              adoptedSession.id,
              adoptedSession.executionId,
              agentStatus,
              existing?.agentSessionId === adoptedSession.id &&
                existing.agentExecutionId === hostPane.muximodExecutionId
                ? {
                    state: existing.state,
                    ...(existing.recentOutput === undefined ? {} : { recentOutput: existing.recentOutput }),
                  }
                : undefined,
            )
          : yield* host.observeUnmanagedAgent(hostPane.hostPaneId, existing?.state ?? "running");
    const name = staleAgentMetadata
      ? hostPane.title || hostPane.command || hostPane.hostPaneId
      : (hostPane.muximodName ??
        adoptedSession?.name ??
        (existing?.name && existing.name !== hostPane.hostPaneId
          ? existing.name
          : hostPane.title || hostPane.command || hostPane.hostPaneId));
    const id = existing?.id ?? reusableMetadataId ?? (yield* attemptSync(() => PaneId.create(`pane-${host.newId()}`)));
    const workspaceId = existing?.workspaceId ?? adoptedSession?.workspaceId;
    const agentExecutionId =
      adoptedSession?.id && hostPane.muximodExecutionId ? hostPane.muximodExecutionId : undefined;
    const executionChanged =
      existing !== undefined &&
      (existing.agentSessionId !== adoptedSession?.id || existing.agentExecutionId !== agentExecutionId);
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
    let record: Pane;
    if (!existing) {
      record = yield* attemptSync(() => Pane.create(createInput));
    } else {
      record = yield* attemptSync(() => {
        const updated = existing.update({
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
        if (updated.state !== observation.state) {
          return executionChanged
            ? updated.resetTo(observation.state, "new execution observed", now)
            : updated.transitionTo(observation.state, "terminal observation", now);
        }
        return updated;
      });
    }
    yield* repository.upsert(record);
    // Geometry and pane indexes are live host state rather than durable identity.
    // Return the live record so the API/UI never loses it during reconciliation.
    records.push(record);
  }

  return records;
});

function resolvePaneKind(
  hostPane: HostPaneSnapshot,
  existing: Pane | undefined,
  adopted: boolean,
  staleAgentMetadata: boolean,
  commandObservation: MuximodPaneClassification,
): Pane["kind"] {
  if (staleAgentMetadata) return "shell";
  if (adopted) return "agent";
  if (hostPane.muximodKind === "agent" && !hostPane.muximodSessionId) return "agent";
  if (hostPane.muximodKind === "shell" || hostPane.muximodKind === "unknown") return hostPane.muximodKind;
  const detected = commandObservation.kind;
  if (detected === "unknown" && existing?.kind === "agent" && adopted) return "agent";
  return detected;
}

const isLiveAgentExecution = Effect.fn("Terminals.isLiveAgentExecution")(function* (
  session: Pick<AgentSession, "status" | "executionPid" | "executionStartedAt">,
) {
  if (session.status !== "running" && session.status !== "resuming") return false;
  if (session.executionPid === undefined || session.executionStartedAt === undefined) return false;
  const host = yield* MuximodHostService;
  return yield* host.isProcessAlive(session.executionPid, session.executionStartedAt);
});
