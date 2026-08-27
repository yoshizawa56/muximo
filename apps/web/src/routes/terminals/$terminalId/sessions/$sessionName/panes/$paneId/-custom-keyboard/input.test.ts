import { noFixture, type OperationCase, type OperationTable, returns, runOperationTable } from "@muximo/test-support";
import { describe, it } from "vitest";
import { encodeCustomKeyboardNativeInput, encodeCustomKeyboardSequence, isCustomKeyboardModifierKey } from "./input";
import type { CustomKeyboardModifier, CustomKeyboardSequence } from "./viewmodel";

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
    name: "encodes Ctrl with a right arrow CSI modifier",
    input: { sequence: [{ type: "key", key: "ArrowRight", modifiers: ["ctrl"] }] },
    assert: [returns<EmptyContext, string>("\u001b[1;5C")],
  },
  {
    name: "encodes Ctrl with a Delete CSI modifier",
    input: { sequence: [{ type: "key", key: "Delete", modifiers: ["ctrl"] }] },
    assert: [returns<EmptyContext, string>("\u001b[3;5~")],
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
    name: "applies a latched Ctrl modifier to an alphabet key token",
    input: {
      sequence: [{ type: "key", key: "c" }],
      activeModifiers: ["ctrl"],
    },
    assert: [returns<EmptyContext, string>("\u0003")],
  },
  {
    name: "encodes Ctrl with terminal control punctuation",
    input: {
      sequence: [{ type: "key", key: "[" }],
      activeModifiers: ["ctrl"],
    },
    assert: [returns<EmptyContext, string>("\u001b")],
  },
  {
    name: "combines Ctrl and Alt on one key token",
    input: {
      sequence: [{ type: "key", key: "c" }],
      activeModifiers: ["ctrl", "alt"],
    },
    assert: [returns<EmptyContext, string>("\u001b\u0003")],
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

type NativeInput = {
  data: string;
  activeModifiers: readonly CustomKeyboardModifier[];
};

const nativeInputCases = [
  {
    name: "applies a latched Ctrl modifier to native alphabet input",
    input: { data: "c", activeModifiers: ["ctrl"] },
    assert: [returns<EmptyContext, string>("\u0003")],
  },
  {
    name: "applies a latched Ctrl modifier to native Enter input",
    input: { data: "\r", activeModifiers: ["ctrl"] },
    assert: [returns<EmptyContext, string>("\n")],
  },
  {
    name: "passes native input through when no modifier is latched",
    input: { data: "c", activeModifiers: [] },
    assert: [returns<EmptyContext, string>("c")],
  },
] satisfies readonly OperationCase<"default", NativeInput, string, EmptyContext>[];

const nativeInputTable: OperationTable<undefined, "default", NativeInput, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: nativeInputCases,
  execute: (_fixture, input) => encodeCustomKeyboardNativeInput(input.data, input.activeModifiers),
  observe: () => ({}),
};

type ModifierKeyInput = string;

const modifierKeyCases = [
  {
    name: "ignores the physical Control key token",
    input: "Control",
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "ignores the physical Alt key token",
    input: "Alt",
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "keeps a regular key available for sequence capture",
    input: "c",
    assert: [returns<EmptyContext, boolean>(false)],
  },
] satisfies readonly OperationCase<"default", ModifierKeyInput, boolean, EmptyContext>[];

const modifierKeyTable: OperationTable<undefined, "default", ModifierKeyInput, boolean, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: modifierKeyCases,
  execute: (_fixture, input) => isCustomKeyboardModifierKey(input),
  observe: () => ({}),
};

describe("encodeCustomKeyboardSequence", () => {
  runOperationTable(it, table);
  runOperationTable(it, nativeInputTable);
  runOperationTable(it, modifierKeyTable);
});
