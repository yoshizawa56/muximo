import {
  hasError,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { readCodexBaseline } from "./internals.js";

type EmptyContext = {};
type BaselineInput = string | null | undefined;

const cases = [
  {
    name: "treats an absent baseline as no sessions",
    input: undefined,
    assert: [returns<EmptyContext, string[]>([])],
  },
  {
    name: "accepts the current baseline format",
    input: JSON.stringify({ codexSessions: ["session-1", "session-2"] }),
    assert: [returns<EmptyContext, string[]>(["session-1", "session-2"])],
  },
  {
    name: "accepts an empty current baseline",
    input: JSON.stringify({ codexSessions: [] }),
    assert: [returns<EmptyContext, string[]>([])],
  },
  {
    name: "rejects invalid baseline JSON",
    input: "not-json",
    assert: [hasError<EmptyContext, string[]>({ message: "Codex session baseline is not valid JSON" })],
  },
  {
    name: "rejects a baseline with an unknown shape",
    input: JSON.stringify({ sessions: ["session-1"] }),
    assert: [
      hasError<EmptyContext, string[]>({
        message: "Codex session baseline must contain codexSessions as an array of non-empty strings",
      }),
    ],
  },
  {
    name: "rejects a baseline with an unknown field",
    input: JSON.stringify({ codexSessions: [], legacySessions: [] }),
    assert: [
      hasError<EmptyContext, string[]>({
        message: "Codex session baseline must contain codexSessions as an array of non-empty strings",
      }),
    ],
  },
  {
    name: "rejects a baseline with non-string session IDs",
    input: JSON.stringify({ codexSessions: ["session-1", 2] }),
    assert: [
      hasError<EmptyContext, string[]>({
        message: "Codex session baseline must contain codexSessions as an array of non-empty strings",
      }),
    ],
  },
] satisfies readonly OperationCase<"default", BaselineInput, string[], EmptyContext>[];

const table: OperationTable<undefined, "default", BaselineInput, string[], EmptyContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => readCodexBaseline(input),
  observe: () => ({}),
};

describe("Codex session baseline parser", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
