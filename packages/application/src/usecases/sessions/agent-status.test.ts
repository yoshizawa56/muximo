import type { PaneState } from "@muximo/domain";
import {
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { type AgentStatusStore, agentStatusKey, readManagedAgentObservation } from "./agent-status.js";

type EmptyContext = {};
type ManagedInput = { sessionId: string; executionId: string; persisted?: ManagedResult };
type ManagedResult = { state: PaneState; recentOutput?: string };
type ManagedFixture = { store: AgentStatusStore };

const managedFixture = (): FixtureHandle<ManagedFixture> => ({
  fixture: { store: new Map() },
});

const waitingFixture = (): FixtureHandle<ManagedFixture> => ({
  fixture: {
    store: new Map([
      [agentStatusKey("session", "execution"), { state: "waiting_input", recentOutput: "Question from provider" }],
    ]),
  },
});

const managedCases = [
  {
    name: "uses a provider waiting state",
    fixture: "waiting",
    input: { sessionId: "session", executionId: "execution" },
    assert: [
      returns<EmptyContext, ManagedResult>({
        state: "waiting_input",
        recentOutput: "Question from provider",
      }),
    ],
  },
  {
    name: "uses neutral running state before provider observation",
    input: { sessionId: "session", executionId: "execution" },
    assert: [returns<EmptyContext, ManagedResult>({ state: "running" })],
  },
  {
    name: "uses a persisted observation for the current execution after restart",
    input: {
      sessionId: "session",
      executionId: "execution",
      persisted: { state: "waiting_approval", recentOutput: "Approve this action" },
    },
    assert: [
      returns<EmptyContext, ManagedResult>({
        state: "waiting_approval",
        recentOutput: "Approve this action",
      }),
    ],
  },
] satisfies readonly OperationCase<"waiting", ManagedInput, ManagedResult, EmptyContext>[];

const managedTable: OperationTable<ManagedFixture, "waiting", ManagedInput, ManagedResult, EmptyContext> = {
  defaultFixture: managedFixture,
  fixtures: { waiting: waitingFixture },
  cases: managedCases,
  execute: (fixture, input) =>
    readManagedAgentObservation(input.sessionId, input.executionId, fixture.store, input.persisted),
  observe: () => ({}),
};

describe("agent status sources", () => {
  runOperationTable(it as unknown as TestRegistrar, managedTable);
});
