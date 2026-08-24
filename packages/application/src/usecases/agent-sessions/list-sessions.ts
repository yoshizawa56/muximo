import type { AgentSessionRecord, AgentSessionState } from "@muximo/domain";
import type {
  AgentSessionListInput,
  AgentSessionListObservation,
  AgentSessionListProjection,
  AgentSessionListResult,
  ManagedAgentSessionRepository,
  SessionListClock,
  SessionObservationPort,
} from "../../ports/agent-sessions.js";

export type ListAgentSessionsDependencies = {
  sessions: ManagedAgentSessionRepository;
  host: SessionObservationPort;
  clock: SessionListClock;
};

export const sessionListPolicy = {
  worktreeCheckGraceMs: 5 * 60 * 1_000,
  staleExecutionGraceMs: 5 * 60 * 1_000,
  longRunningThresholdMs: 30 * 24 * 60 * 60 * 1_000,
} as const;

const activeStates = new Set<AgentSessionState>(["running", "resuming"]);
const resumableStates = new Set<AgentSessionState>(["exited", "interrupted"]);

/** Application policy for projecting and filtering managed agent sessions. */
export class ListAgentSessions {
  public constructor(private readonly deps: ListAgentSessionsDependencies) {}

  public async execute(input: AgentSessionListInput): Promise<AgentSessionListResult> {
    const workspaceId = input.workspaceScope === "all" ? undefined : (await this.deps.host.resolveWorkspace()).id;
    const now = this.deps.clock.now();
    const allViews = await Promise.all(
      (await this.deps.sessions.list(workspaceId)).map(async (session) =>
        projectAgentSession(session, await this.deps.host.observeSession(session, now)),
      ),
    );
    return {
      allViews,
      views: input.includeUnavailable ? allViews : allViews.filter((view) => view.visibleByDefault),
    };
  }
}

export function projectAgentSession(
  session: AgentSessionRecord,
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

export function shouldCheckAgentSessionWorktree(session: AgentSessionRecord, now: number): boolean {
  if (!session.useWorktree) return false;
  const reference = activeStates.has(session.status)
    ? (session.executionStartedAt ?? session.updatedAt)
    : session.updatedAt;
  const age = ageMs(reference, now);
  return age === null || age >= sessionListPolicy.worktreeCheckGraceMs;
}

function classifyExecutionHealth(
  session: AgentSessionRecord,
  observation: AgentSessionListObservation,
): AgentSessionListProjection["executionHealth"] {
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
