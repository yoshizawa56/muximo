import type { AgentSessionRecord, AgentSessionState } from "@muximo/domain";

export const sessionListPolicy = {
  worktreeCheckGraceMs: 5 * 60 * 1_000,
  staleExecutionGraceMs: 5 * 60 * 1_000,
  longRunningThresholdMs: 30 * 24 * 60 * 60 * 1_000,
} as const;

export type SessionWorktreeState =
  | "not_applicable"
  | "available"
  | "missing"
  | "unregistered"
  | "unknown";

export type SessionExecutionHealth =
  | "inactive"
  | "active"
  | "long_running"
  | "stale"
  | "unknown";

export type SessionResumeState = "available" | "unavailable" | "unknown";

export type SessionResumeReason =
  | "backend_session_missing"
  | "backend_session_discovery_required"
  | "currently_running"
  | "execution_state_unknown"
  | "not_resumable_state"
  | "worktree_missing"
  | "worktree_state_unknown"
  | "worktree_unregistered";

export type SessionListObservation = {
  now: number;
  processAlive?: boolean;
  worktreeState: SessionWorktreeState;
};

export type SessionListProjection = {
  session: AgentSessionRecord;
  executionHealth: SessionExecutionHealth;
  resume: SessionResumeState;
  resumeReason: SessionResumeReason | null;
  worktreeState: SessionWorktreeState;
  visibleByDefault: boolean;
};

const activeStates = new Set<AgentSessionState>(["running", "resuming"]);
const resumableStates = new Set<AgentSessionState>(["exited", "interrupted"]);

export function projectAgentSession(
  session: AgentSessionRecord,
  observation: SessionListObservation,
): SessionListProjection {
  const executionHealth = classifyExecutionHealth(session, observation);
  const resume = classifyResumeState(session, executionHealth, observation.worktreeState);
  const hiddenWorktreeState = observation.worktreeState === "missing" || observation.worktreeState === "unregistered";
  const visibleByDefault = !(hiddenWorktreeState && (resumableStates.has(session.status) || session.status === "exited"));

  return {
    session,
    executionHealth,
    resume: resume.state,
    resumeReason: resume.reason,
    worktreeState: observation.worktreeState,
    visibleByDefault,
  };
}

export function shouldCheckSessionWorktree(session: AgentSessionRecord, now: number): boolean {
  if (!session.useWorktree) return false;
  const reference = activeStates.has(session.status)
    ? session.executionStartedAt ?? session.updatedAt
    : session.updatedAt;
  const age = ageMs(reference, now);
  return age === null || age >= sessionListPolicy.worktreeCheckGraceMs;
}

function classifyExecutionHealth(
  session: AgentSessionRecord,
  observation: SessionListObservation,
): SessionExecutionHealth {
  if (!activeStates.has(session.status)) return "inactive";

  const reference = session.executionStartedAt ?? session.updatedAt;
  const age = ageMs(reference, observation.now);
  if (observation.processAlive === false || (observation.processAlive === undefined && session.executionPid == null)) {
    return age === null || age >= sessionListPolicy.staleExecutionGraceMs ? "stale" : "unknown";
  }
  if (observation.processAlive === undefined) return "unknown";
  if (age !== null && age >= sessionListPolicy.longRunningThresholdMs) return "long_running";
  return "active";
}

function classifyResumeState(
  session: AgentSessionRecord,
  executionHealth: SessionExecutionHealth,
  worktreeState: SessionWorktreeState,
): { state: SessionResumeState; reason: SessionResumeReason | null } {
  if (worktreeState === "missing") return { state: "unavailable", reason: "worktree_missing" };
  if (worktreeState === "unregistered") return { state: "unavailable", reason: "worktree_unregistered" };

  if (activeStates.has(session.status)) {
    if (executionHealth === "stale") return classifyBackendResumeState(session);
    if (executionHealth === "unknown") return { state: "unknown", reason: "execution_state_unknown" };
    return { state: "unavailable", reason: "currently_running" };
  }

  if (!resumableStates.has(session.status)) {
    return { state: "unavailable", reason: "not_resumable_state" };
  }
  if (worktreeState === "unknown") return { state: "unknown", reason: "worktree_state_unknown" };
  return classifyBackendResumeState(session);
}

function classifyBackendResumeState(session: AgentSessionRecord): { state: SessionResumeState; reason: SessionResumeReason | null } {
  if (session.backend === "claude" && !session.backendSessionId) {
    return { state: "unavailable", reason: "backend_session_missing" };
  }
  if (session.backend === "codex" && !session.backendSessionId) {
    return { state: "unknown", reason: "backend_session_discovery_required" };
  }
  if (session.backend === "opencode" && !session.backendSessionId) {
    return { state: "unavailable", reason: "backend_session_missing" };
  }
  return { state: "available", reason: null };
}

function ageMs(value: string | null | undefined, now: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, now - parsed);
}
