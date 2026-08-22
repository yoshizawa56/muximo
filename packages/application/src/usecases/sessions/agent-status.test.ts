import { describe, it } from "vitest";
import {
  noFixture,
  returns,
  runOperationTable,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import type { PaneState } from "@muximo/domain";
import { inferUnmanagedAgentState, readManagedAgentObservation } from "./agent-status.js";

type StateInput = { output: string; fallback: PaneState };
type EmptyContext = {};

const cases = [
  { name: "detects an unmanaged approval prompt", input: { output: "Allow this change?", fallback: "running" }, assert: [returns<EmptyContext, PaneState>("waiting_approval")] },
  { name: "detects an unmanaged input prompt", input: { output: "What should I do next?", fallback: "running" }, assert: [returns<EmptyContext, PaneState>("waiting_input")] },
  { name: "strips ANSI sequences before classifying a prompt", input: { output: "\u001b[31mPress Enter to continue\u001b[0m", fallback: "running" }, assert: [returns<EmptyContext, PaneState>("waiting_input")] },
  { name: "keeps ordinary unmanaged output running", input: { output: "Working on the task", fallback: "waiting_input" }, assert: [returns<EmptyContext, PaneState>("running")] },
  { name: "keeps the fallback when an unmanaged pane has no output", input: { output: "", fallback: "waiting_input" }, assert: [returns<EmptyContext, PaneState>("waiting_input")] },
] satisfies readonly OperationCase<"default", StateInput, PaneState, EmptyContext>[];

const table: OperationTable<undefined, "default", StateInput, PaneState, EmptyContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => inferUnmanagedAgentState(input.output, input.fallback),
  observe: () => ({}),
};

type ManagedInput = { state?: PaneState; recentOutput?: string };
const managedCases = [
  { name: "uses a provider waiting state", input: { state: "waiting_input", recentOutput: "Question from provider" }, assert: [returns<EmptyContext, { state: PaneState; recentOutput?: string }>({ state: "waiting_input", recentOutput: "Question from provider" })] },
  { name: "uses neutral running state before provider observation", input: {}, assert: [returns<EmptyContext, { state: PaneState }>({ state: "running" })] },
] satisfies readonly OperationCase<"default", ManagedInput, { state: PaneState; recentOutput?: string }, EmptyContext>[];

const managedTable: OperationTable<undefined, "default", ManagedInput, { state: PaneState; recentOutput?: string }, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: managedCases,
  execute: (_fixture, input) => {
    const agentStatus = new Map();
    if (input.state) agentStatus.set("session:execution", { state: input.state, recentOutput: input.recentOutput });
    return readManagedAgentObservation("session", "execution", agentStatus);
  },
  observe: () => ({}),
};

describe("agent status sources", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
  runOperationTable(it as unknown as TestRegistrar, managedTable);
});
