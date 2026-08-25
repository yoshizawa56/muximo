import { noFixture, type OperationCase, type OperationTable, returns, runOperationTable } from "@muximo/test-support";
import { describe, it } from "vitest";
import { encodeCustomKeyboardSequence } from "./-custom-keyboard-input";
import type { CustomKeyboardModifier, CustomKeyboardSequence } from "./-custom-keyboard-viewmodel";

type EmptyContext = {};
type Input = {
  sequence: CustomKeyboardSequence;
  activeModifiers?: readonly CustomKeyboardModifier[];
};

const cases = [
  {
    name: "encodes printable text as terminal input",
    input: { sequence: [{ type: "text", value: "git status" }] },
    assert: [returns<EmptyContext, string>("git status")],
  },
  {
    name: "encodes Enter as a carriage return",
    input: { sequence: [{ type: "key", key: "Enter" }] },
    assert: [returns<EmptyContext, string>("\r")],
  },
  {
    name: "encodes Ctrl+C as the control-C byte",
    input: { sequence: [{ type: "key", key: "c", modifiers: ["ctrl"] }] },
    assert: [returns<EmptyContext, string>("\u0003")],
  },
  {
    name: "encodes Alt with an escape prefix",
    input: { sequence: [{ type: "key", key: "ArrowRight", modifiers: ["alt"] }] },
    assert: [returns<EmptyContext, string>("\u001b\u001b[C")],
  },
  {
    name: "encodes Shift+Tab as reverse tab",
    input: { sequence: [{ type: "key", key: "Tab", modifiers: ["shift"] }] },
    assert: [returns<EmptyContext, string>("\u001b[Z")],
  },
  {
    name: "applies a latched modifier to the first sequence token",
    input: {
      sequence: [{ type: "text", value: "c" }],
      activeModifiers: ["ctrl"],
    },
    assert: [returns<EmptyContext, string>("\u0003")],
  },
  {
    name: "keeps a shortcut text token followed by Enter",
    input: {
      sequence: [
        { type: "text", value: "bun test" },
        { type: "key", key: "Enter" },
      ],
    },
    assert: [returns<EmptyContext, string>("bun test\r")],
  },
] satisfies readonly OperationCase<"default", Input, string, EmptyContext>[];

const table: OperationTable<undefined, "default", Input, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => encodeCustomKeyboardSequence(input.sequence, input.activeModifiers),
  observe: () => ({}),
};

describe("encodeCustomKeyboardSequence", () => {
  runOperationTable(it, table);
});
