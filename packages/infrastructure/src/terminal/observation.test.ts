import type { MuximodPaneClassification, MuximodPaneObservation } from "@muximo/application";
import type { PaneState } from "@muximo/domain";
import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { classifyTerminalCommand, classifyUnmanagedAgentOutput } from "./observation.js";

type EmptyContext = {};
type CommandInput = { command: string };

const commandCases = [
  {
    name: "classifies an absolute shell command",
    input: { command: "/bin/zsh -l" },
    assert: [returns<EmptyContext, MuximodPaneClassification>({ kind: "shell" })],
  },
  {
    name: "classifies a known agent command and preserves its neutral identifier",
    input: { command: "codex --profile local-agent" },
    assert: [returns<EmptyContext, MuximodPaneClassification>({ kind: "agent", agentId: "codex" })],
  },
  {
    name: "classifies an unrecognized executable as unknown",
    input: { command: "python worker.py" },
    assert: [returns<EmptyContext, MuximodPaneClassification>({ kind: "unknown" })],
  },
] satisfies readonly OperationCase<"default", CommandInput, MuximodPaneClassification, EmptyContext>[];

const commandTable: OperationTable<undefined, "default", CommandInput, MuximodPaneClassification, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: commandCases,
  execute: (_fixture, input) => classifyTerminalCommand(input.command),
  observe: () => ({}),
};

type OutputInput = { output: string; fallback: PaneState };

const outputCases = [
  {
    name: "classifies an approval prompt after removing ANSI sequences",
    input: { output: "\u001b[31mAllow this change?\u001b[0m", fallback: "running" },
    assert: [returns<EmptyContext, MuximodPaneObservation>({ state: "waiting_approval" })],
  },
  {
    name: "classifies an input prompt",
    input: { output: "What should I do next?", fallback: "running" },
    assert: [returns<EmptyContext, MuximodPaneObservation>({ state: "waiting_input" })],
  },
  {
    name: "keeps the fallback when output is empty",
    input: { output: "", fallback: "waiting_input" },
    assert: [returns<EmptyContext, MuximodPaneObservation>({ state: "waiting_input" })],
  },
] satisfies readonly OperationCase<"default", OutputInput, MuximodPaneObservation, EmptyContext>[];

const outputTable: OperationTable<undefined, "default", OutputInput, MuximodPaneObservation, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: outputCases,
  execute: (_fixture, input) => classifyUnmanagedAgentOutput(input.output, input.fallback),
  observe: () => ({}),
};

describe("terminal observation", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, commandTable);
  runOperationTable(register, outputTable);
});
