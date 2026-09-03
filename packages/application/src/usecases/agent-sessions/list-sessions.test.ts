import { AgentSession, AgentSessionId, WorkspaceId } from "@muximo/domain";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect } from "effect";
import { describe, it } from "vitest";
import { type AgentSessionListObservation, type AgentSessionListResult, ListAgentSessions } from "../../index.js";

type Fixture = {
  sessions: AgentSession[];
  observation: AgentSessionListObservation;
};

type Context = {
  resume: AgentSessionListResult["views"][number]["resume"] | undefined;
  reason: AgentSessionListResult["views"][number]["resumeReason"] | undefined;
  executionHealth: AgentSessionListResult["views"][number]["executionHealth"] | undefined;
  visibleByDefault: boolean | undefined;
};

const workspaceId = WorkspaceId.create("workspace-id");

function sessionFixture(overrides: Partial<AgentSession> = {}): AgentSession {
  return AgentSession.create({
    id: AgentSessionId.create("session-id"),
    name: "session",
    backend: "codex",
    status: "exited",
    workspaceId,
    workspaceRoot: "/workspace",
    workspaceName: "workspace",
    useWorktree: false,
    setupRan: false,
    resuming: false,
    lastActivityAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  });
}

function createFixture(observation: AgentSessionListObservation, session = sessionFixture()): { fixture: Fixture } {
  return { fixture: { sessions: [session], observation } };
}

type CaseKey = "available" | "missing" | "running" | "discovery" | "worktree-missing";
type Input = { includeUnavailable: boolean };

const cases = [
  {
    name: "projects an exited session with a known backend session as resumable",
    fixture: "available",
    input: { includeUnavailable: true },
    assert: [
      hasObserved<Context, AgentSessionListResult>("resume", "available"),
      hasObserved<Context, AgentSessionListResult>("reason", null),
    ],
  },
  {
    name: "projects an exited session with a missing backend session as unavailable",
    fixture: "missing",
    input: { includeUnavailable: true },
    assert: [
      hasObserved<Context, AgentSessionListResult>("resume", "unavailable"),
      hasObserved<Context, AgentSessionListResult>("reason", "backend_session_missing"),
    ],
  },
  {
    name: "does not offer resume while the process is alive",
    fixture: "running",
    input: { includeUnavailable: true },
    assert: [
      hasObserved<Context, AgentSessionListResult>("resume", "unavailable"),
      hasObserved<Context, AgentSessionListResult>("reason", "currently_running"),
      hasObserved<Context, AgentSessionListResult>("executionHealth", "active"),
    ],
  },
  {
    name: "reports discovery-required backend state as unknown",
    fixture: "discovery",
    input: { includeUnavailable: true },
    assert: [
      hasObserved<Context, AgentSessionListResult>("resume", "unknown"),
      hasObserved<Context, AgentSessionListResult>("reason", "backend_session_discovery_required"),
    ],
  },
  {
    name: "hides a resumable session whose worktree is missing",
    fixture: "worktree-missing",
    input: { includeUnavailable: false },
    assert: [
      hasObserved<Context, AgentSessionListResult>("resume", "unavailable"),
      hasObserved<Context, AgentSessionListResult>("reason", "worktree_missing"),
      hasObserved<Context, AgentSessionListResult>("visibleByDefault", false),
    ],
  },
] satisfies readonly OperationCase<CaseKey, Input, AgentSessionListResult, Context>[];

const table: OperationTable<Fixture, CaseKey, Input, AgentSessionListResult, Context> = {
  defaultFixture: () =>
    createFixture({
      now: Date.parse("2026-08-23T00:05:00.000Z"),
      processAlive: undefined,
      worktreeState: "not_applicable",
      backendResumeState: "available",
    }),
  fixtures: {
    available: () =>
      createFixture({
        now: Date.parse("2026-08-23T00:05:00.000Z"),
        processAlive: undefined,
        worktreeState: "not_applicable",
        backendResumeState: "available",
      }),
    missing: () =>
      createFixture({
        now: Date.parse("2026-08-23T00:05:00.000Z"),
        processAlive: undefined,
        worktreeState: "not_applicable",
        backendResumeState: "missing",
      }),
    running: () =>
      createFixture(
        {
          now: Date.parse("2026-08-23T00:05:00.000Z"),
          processAlive: true,
          worktreeState: "not_applicable",
          backendResumeState: "available",
        },
        sessionFixture({
          status: "running",
          executionPid: 700,
          executionStartedAt: "2026-08-23T00:04:00.000Z",
          lastActivityAt: "2026-08-23T00:04:00.000Z",
          backendSessionId: "backend-session",
        }),
      ),
    discovery: () =>
      createFixture(
        {
          now: Date.parse("2026-08-23T00:05:00.000Z"),
          processAlive: false,
          worktreeState: "not_applicable",
          backendResumeState: "discovery_required",
        },
        sessionFixture({
          status: "running",
          executionPid: 700,
          executionStartedAt: "2026-08-23T00:00:00.000Z",
          lastActivityAt: "2026-08-23T00:00:00.000Z",
        }),
      ),
    "worktree-missing": () =>
      createFixture(
        {
          now: Date.parse("2026-08-23T00:05:00.000Z"),
          processAlive: undefined,
          worktreeState: "missing",
          backendResumeState: "available",
        },
        sessionFixture({ useWorktree: true, worktreePath: "/missing/session" }),
      ),
  },
  cases,
  execute: (fixture, input) =>
    new ListAgentSessions({
      sessions: {
        findById: () => Effect.succeed(undefined),
        findByName: () => Effect.succeed(undefined),
        list: () => Effect.succeed(fixture.sessions),
        insert: () => Effect.succeed(undefined),
        update: () => Effect.succeed(undefined),
        claimExecution: () => Effect.succeed(true),
        claimAbandonedExecution: () => Effect.succeed(false),
        attachExecution: () => Effect.succeed(false),
        findExecutionReceipt: () => Effect.succeed(undefined),
        saveExecutionReceipt: () => Effect.succeed(undefined),
        delete: () => Effect.succeed(undefined),
      },
      host: {
        resolveWorkspace: () => Effect.succeed({ id: workspaceId }),
        observeSession: () => Effect.succeed(fixture.observation),
      },
      clock: { now: () => fixture.observation.now },
    }).execute({ workspaceScope: "current", includeUnavailable: input.includeUnavailable }),
  observe: (_fixture, result) => ({
    resume: result.ok ? result.value.allViews[0]?.resume : undefined,
    reason: result.ok ? result.value.allViews[0]?.resumeReason : undefined,
    executionHealth: result.ok ? result.value.allViews[0]?.executionHealth : undefined,
    visibleByDefault: result.ok ? result.value.allViews[0]?.visibleByDefault : undefined,
  }),
};

describe("managed agent session list policy", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
