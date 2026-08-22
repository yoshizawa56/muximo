import { describe, it } from "vitest";
import {
  noFixture,
  returns,
  runOperationTable,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { AgentSession, AgentSessionId, WorkspaceId, type AgentSessionRecord, type AgentSessionState } from "@muximo/domain";
import {
  projectAgentSession,
  sessionListPolicy,
  shouldCheckSessionWorktree,
  type SessionListObservation,
  type SessionListProjection,
} from "./session-list.js";

type ProjectionContext = {};
type ProjectionResult = Pick<SessionListProjection, "executionHealth" | "resume" | "resumeReason" | "worktreeState" | "visibleByDefault">;
type ProjectionInput = {
  session?: Partial<AgentSessionRecord>;
  observation: SessionListObservation;
};

const now = Date.parse("2026-08-15T00:00:00.000Z");
const old = new Date(now - sessionListPolicy.longRunningThresholdMs - 1_000).toISOString();
const recent = new Date(now - 1_000).toISOString();

const projectionCases = [
  {
    name: "keeps an exited session with an available worktree visible and resumable",
    input: { session: { status: "exited", updatedAt: old }, observation: { now, processAlive: undefined, worktreeState: "available" } },
    assert: [returns<ProjectionContext, ProjectionResult>({ executionHealth: "inactive", resume: "available", resumeReason: null, worktreeState: "available", visibleByDefault: true })],
  },
  {
    name: "hides an exited session whose worktree is missing",
    input: { session: { status: "exited", updatedAt: old }, observation: { now, processAlive: undefined, worktreeState: "missing" } },
    assert: [returns<ProjectionContext, ProjectionResult>({ executionHealth: "inactive", resume: "unavailable", resumeReason: "worktree_missing", worktreeState: "missing", visibleByDefault: false })],
  },
  {
    name: "hides an interrupted session whose worktree is no longer registered",
    input: { session: { status: "interrupted", updatedAt: old }, observation: { now, processAlive: undefined, worktreeState: "unregistered" } },
    assert: [returns<ProjectionContext, ProjectionResult>({ executionHealth: "inactive", resume: "unavailable", resumeReason: "worktree_unregistered", worktreeState: "unregistered", visibleByDefault: false })],
  },
  {
    name: "keeps a recent exited session uncertain while worktree inspection is deferred",
    input: { session: { status: "exited", updatedAt: recent }, observation: { now, processAlive: undefined, worktreeState: "unknown" } },
    assert: [returns<ProjectionContext, ProjectionResult>({ executionHealth: "inactive", resume: "unknown", resumeReason: "worktree_state_unknown", worktreeState: "unknown", visibleByDefault: true })],
  },
  {
    name: "marks a recent live execution as active",
    input: { session: { status: "running", executionStartedAt: recent, updatedAt: recent, executionPid: 100 }, observation: { now, processAlive: true, worktreeState: "not_applicable" } },
    assert: [returns<ProjectionContext, ProjectionResult>({ executionHealth: "active", resume: "unavailable", resumeReason: "currently_running", worktreeState: "not_applicable", visibleByDefault: true })],
  },
  {
    name: "marks a month-old live execution as long-running",
    input: { session: { status: "running", executionStartedAt: old, updatedAt: old, executionPid: 100 }, observation: { now, processAlive: true, worktreeState: "not_applicable" } },
    assert: [returns<ProjectionContext, ProjectionResult>({ executionHealth: "long_running", resume: "unavailable", resumeReason: "currently_running", worktreeState: "not_applicable", visibleByDefault: true })],
  },
  {
    name: "marks a dead long-running execution as stale and resumable",
    input: { session: { status: "running", executionStartedAt: old, updatedAt: old, executionPid: 100 }, observation: { now, processAlive: false, worktreeState: "available" } },
    assert: [returns<ProjectionContext, ProjectionResult>({ executionHealth: "stale", resume: "available", resumeReason: null, worktreeState: "available", visibleByDefault: true })],
  },
  {
    name: "keeps stale Codex execution recovery uncertain when discovery is required",
    input: { session: { backend: "codex", backendSessionId: undefined, status: "running", executionStartedAt: old, updatedAt: old, executionPid: undefined }, observation: { now, processAlive: undefined, worktreeState: "not_applicable" } },
    assert: [returns<ProjectionContext, ProjectionResult>({ executionHealth: "stale", resume: "unknown", resumeReason: "backend_session_discovery_required", worktreeState: "not_applicable", visibleByDefault: true })],
  },
  {
    name: "keeps stale executions with missing worktrees visible for recovery",
    input: { session: { status: "running", executionStartedAt: old, updatedAt: old, executionPid: 100 }, observation: { now, processAlive: false, worktreeState: "missing" } },
    assert: [returns<ProjectionContext, ProjectionResult>({ executionHealth: "stale", resume: "unavailable", resumeReason: "worktree_missing", worktreeState: "missing", visibleByDefault: true })],
  },
] satisfies readonly OperationCase<"default", ProjectionInput, ProjectionResult, ProjectionContext>[];

const projectionTable: OperationTable<undefined, "default", ProjectionInput, ProjectionResult, ProjectionContext> = {
  defaultFixture: noFixture(),
  cases: projectionCases,
  execute: (_fixture, input) => {
    const session = { ...sessionFixture(), ...input.session };
    const projection = projectAgentSession(session, input.observation);
    return {
      executionHealth: projection.executionHealth,
      resume: projection.resume,
      resumeReason: projection.resumeReason,
      worktreeState: projection.worktreeState,
      visibleByDefault: projection.visibleByDefault,
    };
  },
  observe: (_fixture, result) => result.ok ? result.value : {},
};

type WorktreeCheckContext = {};
type WorktreeCheckInput = {
  session: Partial<AgentSessionRecord>;
  now: number;
};

const worktreeCheckCases = [
  {
    name: "does not require a worktree check during the grace period",
    input: { session: { useWorktree: true, updatedAt: recent }, now },
    assert: [returns<WorktreeCheckContext, boolean>(false)],
  },
  {
    name: "checks an old worktree-backed session",
    input: { session: { useWorktree: true, updatedAt: old }, now },
    assert: [returns<WorktreeCheckContext, boolean>(true)],
  },
  {
    name: "uses execution start time for an active worktree session",
    input: { session: { useWorktree: true, status: "running", executionStartedAt: old, updatedAt: recent }, now },
    assert: [returns<WorktreeCheckContext, boolean>(true)],
  },
  {
    name: "does not inspect sessions without managed worktrees",
    input: { session: { useWorktree: false, updatedAt: old }, now },
    assert: [returns<WorktreeCheckContext, boolean>(false)],
  },
] satisfies readonly OperationCase<"default", WorktreeCheckInput, boolean, WorktreeCheckContext>[];

const worktreeCheckTable: OperationTable<undefined, "default", WorktreeCheckInput, boolean, WorktreeCheckContext> = {
  defaultFixture: noFixture(),
  cases: worktreeCheckCases,
  execute: (_fixture, input) => shouldCheckSessionWorktree({ ...sessionFixture(), ...input.session }, input.now),
  observe: (_fixture, result) => result.ok ? result.value : false,
};

describe("muximo session list projection", () => {
  runOperationTable(it as unknown as TestRegistrar, projectionTable);
  runOperationTable(it as unknown as TestRegistrar, worktreeCheckTable);
});

function sessionFixture(): AgentSessionRecord {
  return AgentSession.create({
    id: AgentSessionId.create("session-id"),
    name: "review",
    backend: "claude",
    status: "exited",
    workspaceId: WorkspaceId.create("workspace-id"),
    workspaceRoot: "/workspace",
    workspaceName: "workspace",
    worktreeRoot: "/worktrees",
    worktreePath: "/worktrees/review",
    branch: "muximo/review",
    baseCommit: "base-commit",
    useWorktree: true,
    backendSessionId: "backend-session-id",
    setupRan: false,
    resuming: false,
    lastExitStatus: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: recent,
  });
}
