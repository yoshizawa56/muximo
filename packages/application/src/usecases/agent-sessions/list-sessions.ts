import type { AgentSession, AgentSessionState } from "@muximo/domain";
import { Effect } from "effect";
import type {
  AgentSessionListInput,
  AgentSessionListObservation,
  AgentSessionListProjection,
} from "../../ports/agent-sessions.js";
import {
  ManagedAgentSessionRepositoryService,
  SessionListClockService,
  SessionObservationService,
} from "./agent-session-services.js";

export const sessionListPolicy = {
  worktreeCheckGraceMs: 5 * 60 * 1_000,
  staleExecutionGraceMs: 5 * 60 * 1_000,
  longRunningThresholdMs: 30 * 24 * 60 * 60 * 1_000,
} as const;

const activeStates = new Set<AgentSessionState>(["running", "resuming", "recovering"]);
const resumableStates = new Set<AgentSessionState>(["exited", "interrupted"]);

/** Application policy for projecting and filtering managed agent sessions. */
export class ListAgentSessions {
  public readonly execute = Effect.fn("AgentSessions.list")(
    { self: this },
    function* (this: ListAgentSessions, input: AgentSessionListInput) {
      const sessionsRepository = yield* ManagedAgentSessionRepositoryService;
      const observation = yield* SessionObservationService;
      const clock = yield* SessionListClockService;
      const workspaceId = input.workspaceScope === "all" ? undefined : (yield* observation.resolveWorkspace()).id;
      const now = clock.now();
      const sessions = yield* sessionsRepository.list(workspaceId);
      const allViews = yield* Effect.all(
        sessions.map((session) =>
          observation
            .observeSession(session, now)
            .pipe(Effect.map((observation) => projectAgentSession(session, observation))),
        ),
      );
      return {
        allViews,
        views: input.includeUnavailable ? allViews : allViews.filter((view) => view.visibleByDefault),
      };
    },
  );
}

export function projectAgentSession(
  session: AgentSession,
  observation: AgentSessionListObservation,
): AgentSessionListProjection {
  const executionHealth = classifyExecutionHealth(session, observation);
  const resume = classifyResumeState(session, executionHealth, observation);
  const hiddenWorktreeState = observation.worktreeState === "missing" || observation.worktreeState === "unregistered";
  const visibleByDefault = !(
    hiddenWorktreeState &&
    (resumableStates.has(session.status) || session.status === "exited")
  );

  return {
    session,
    executionHealth,
    resume: resume.state,
    resumeReason: resume.reason,
    worktreeState: observation.worktreeState,
    visibleByDefault,
  };
}

export function shouldCheckAgentSessionWorktree(session: AgentSession, now: number): boolean {
  if (!session.useWorktree) return false;
  const reference = activeStates.has(session.status)
    ? (session.executionStartedAt ?? session.lastActivityAt)
    : session.lastActivityAt;
  const age = ageMs(reference, now);
  return age === null || age >= sessionListPolicy.worktreeCheckGraceMs;
}

function classifyExecutionHealth(
  session: AgentSession,
  observation: AgentSessionListObservation,
): AgentSessionListProjection["executionHealth"] {
  if (!activeStates.has(session.status)) return "inactive";

  const reference = session.executionStartedAt ?? session.lastActivityAt;
  const age = ageMs(reference, observation.now);
  if (session.executionPid === undefined) return "unknown";
  if (observation.processAlive === false) {
    return age === null || age >= sessionListPolicy.staleExecutionGraceMs ? "stale" : "unknown";
  }
  if (observation.processAlive === undefined) return "unknown";
  if (age !== null && age >= sessionListPolicy.longRunningThresholdMs) return "long_running";
  return "active";
}

function classifyResumeState(
  session: AgentSession,
  executionHealth: AgentSessionListProjection["executionHealth"],
  observation: AgentSessionListObservation,
): { state: AgentSessionListProjection["resume"]; reason: AgentSessionListProjection["resumeReason"] } {
  const worktreeState = observation.worktreeState;
  if (worktreeState === "missing") return { state: "unavailable", reason: "worktree_missing" };
  if (worktreeState === "unregistered") return { state: "unavailable", reason: "worktree_unregistered" };

  if (activeStates.has(session.status)) {
    if (executionHealth === "stale") return classifyBackendResumeState(observation);
    if (executionHealth === "unknown") return { state: "unknown", reason: "execution_state_unknown" };
    return { state: "unavailable", reason: "currently_running" };
  }

  if (!resumableStates.has(session.status)) return { state: "unavailable", reason: "not_resumable_state" };
  if (worktreeState === "unknown") return { state: "unknown", reason: "worktree_state_unknown" };
  return classifyBackendResumeState(observation);
}

function classifyBackendResumeState(observation: AgentSessionListObservation): {
  state: AgentSessionListProjection["resume"];
  reason: AgentSessionListProjection["resumeReason"];
} {
  if (observation.backendResumeState === "available") return { state: "available", reason: null };
  if (observation.backendResumeState === "discovery_required") {
    return { state: "unknown", reason: "backend_session_discovery_required" };
  }
  return { state: "unavailable", reason: "backend_session_missing" };
}

function ageMs(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}
