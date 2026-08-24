import type { AgentSessionListObservation } from "@muximo/application";
import { AgentSession, AgentSessionId, WorkspaceId } from "@muximo/domain";
import {
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { AgentSessionObservationAdapter } from "./observation.js";

type Input = {
  backend: "codex" | "claude" | "opencode";
  backendSessionId?: string;
};

type Context = {
  observation?: AgentSessionListObservation;
  backendResumeState?: AgentSessionListObservation["backendResumeState"];
  worktreeState?: AgentSessionListObservation["worktreeState"];
};

const cases = [
  {
    name: "classifies a provider session with an ID as resume available",
    input: { backend: "codex", backendSessionId: "codex-session" },
    assert: [
      hasObserved<Context, AgentSessionListObservation>("observation", {
        now: 1_725_000_000_000,
        processAlive: undefined,
        worktreeState: "not_applicable",
        backendResumeState: "available",
      }),
    ],
  },
  {
    name: "classifies Codex without an ID as discovery required",
    input: { backend: "codex" },
    assert: [hasObserved<Context, AgentSessionListObservation>("backendResumeState", "discovery_required")],
  },
  {
    name: "classifies a non-Codex provider without an ID as missing",
    input: { backend: "claude" },
    assert: [hasObserved<Context, AgentSessionListObservation>("backendResumeState", "missing")],
  },
] satisfies readonly OperationCase<"default", Input, AgentSessionListObservation, Context>[];

const table: OperationTable<undefined, "default", Input, AgentSessionListObservation, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: async (_fixture, input) => {
    const adapter = new AgentSessionObservationAdapter({
      environment: { PATH: process.env.PATH ?? "" },
      resolveWorkspace: async () => ({ id: WorkspaceId.create("workspace-id") }),
    });
    const session = AgentSession.create({
      id: AgentSessionId.create("session-id"),
      name: "session",
      backend: input.backend,
      status: "exited",
      workspaceId: WorkspaceId.create("workspace-id"),
      workspaceRoot: "/workspace",
      workspaceName: "workspace",
      useWorktree: false,
      ...(input.backendSessionId ? { backendSessionId: input.backendSessionId } : {}),
      setupRan: false,
      resuming: false,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    });
    return adapter.observeSession(session, 1_725_000_000_000);
  },
  observe: (_fixture, result) => ({
    observation: result.ok ? result.value : undefined,
    backendResumeState: result.ok ? result.value.backendResumeState : undefined,
    worktreeState: result.ok ? result.value.worktreeState : undefined,
  }),
};

describe("CLI session observation adapter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
