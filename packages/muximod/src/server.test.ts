import {
  AgentSession,
  AgentSessionId,
  type AgentSessionRecord,
  WorkspaceId,
  type WorkspaceRecord,
} from "@muximo/domain";
import {
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { createAgentPanePublication } from "./server.js";

type PaneStep = { operation: "adopt" | "publish" | "observe" | "release" };
type PaneFixture = {
  publication: ReturnType<typeof createAgentPanePublication>;
  session: AgentSessionRecord;
  calls: string[];
  logEvents: string[];
};
type PaneContext = {
  calls: readonly string[];
  logEvents: readonly string[];
};

const workspace: WorkspaceRecord = {
  id: WorkspaceId.create("workspace-id"),
  rootPath: "/workspace",
  name: "workspace",
  isGit: false,
  worktreeCopyPatterns: [],
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

function session(): AgentSessionRecord {
  return AgentSession.create({
    id: AgentSessionId.create("session-id"),
    name: "session",
    backend: "codex",
    status: "running",
    workspaceId: workspace.id,
    workspaceRoot: workspace.rootPath,
    workspaceName: workspace.name,
    useWorktree: false,
    setupRan: false,
    resuming: false,
    executionId: "execution-id-123456",
    executionPid: 700,
    executionStartedAt: "2026-08-23T00:00:00.000Z",
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  });
}

const fixture = (): FixtureHandle<PaneFixture> => {
  const calls: string[] = [];
  const logEvents: string[] = [];
  const publication = createAgentPanePublication(
    () => ({
      adoptAgentSession: async () => {
        calls.push("adopt:%1");
        throw new Error("adopt failed");
      },
      observeAgentSession: async (input) => {
        calls.push(`observe:%1:${input.state}`);
        throw new Error("observe failed");
      },
      releaseAgentSession: async () => {
        calls.push("release:%1");
        throw new Error("release failed");
      },
    }),
    {
      warn: (event) => logEvents.push(event),
      debug: (event) => logEvents.push(event),
    },
  );
  return {
    fixture: { publication, session: session(), calls, logEvents },
    cleanup: async () => undefined,
  };
};

const cases = [
  {
    name: "keeps pane publication failures out of the agent request",
    steps: [{ operation: "adopt" }, { operation: "publish" }, { operation: "observe" }, { operation: "release" }],
    assert: [
      hasObserved<PaneContext, undefined>("calls", [
        "adopt:%1",
        "observe:%1:completed",
        "observe:%1:waiting_input",
        "release:%1",
      ]),
      hasObserved<PaneContext, undefined>("logEvents", [
        "pane.adopt_failed",
        "pane.publish_failed",
        "pane.observe_failed",
        "pane.release_failed",
      ]),
    ],
  },
] satisfies readonly ScenarioCase<"default", PaneStep, undefined, PaneContext>[];

const table: ScenarioTable<PaneFixture, "default", PaneStep, undefined, PaneContext> = {
  defaultFixture: fixture,
  cases,
  execute: async (testFixture, steps) => {
    for (const step of steps) {
      if (step.operation === "adopt") await testFixture.publication.adopt(testFixture.session, "%1");
      else if (step.operation === "publish")
        await testFixture.publication.publish(testFixture.session, "completed", "%1");
      else if (step.operation === "observe")
        await testFixture.publication.observe(testFixture.session, { state: "waiting_input" });
      else await testFixture.publication.release(testFixture.session, "%1");
    }
  },
  observe: (testFixture) => ({ calls: [...testFixture.calls], logEvents: [...testFixture.logEvents] }),
};

describe("muximod agent pane publication", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});
