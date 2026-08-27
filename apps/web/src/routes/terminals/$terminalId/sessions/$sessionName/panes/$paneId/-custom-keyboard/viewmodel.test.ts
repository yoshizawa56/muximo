import { noFixture, type OperationCase, type OperationTable, returns, runOperationTable } from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  customKeyboardAbcLetterRow,
  customKeyboardAbcRows,
  customKeyboardNumberRows,
  customKeyboardPunctuationRow,
} from "./layout";
import {
  applyCustomKeyboardDrop,
  type CustomKeyboardButton,
  type CustomKeyboardDragSource,
  type CustomKeyboardDropTarget,
  type CustomKeyboardModifier,
  customKeyboardButtonLibrary,
  customKeyboardTerminalActionOptions,
  defaultCustomKeyboardButtons,
  insertButtonIdBeforeTarget,
  isCustomKeyboardShortcutDraftValid,
  parseCustomKeyboardState,
  selectedButtonsFromIds,
  toggleCustomKeyboardModifier,
} from "./viewmodel";

type EmptyContext = {};

const selectionLibrary: readonly CustomKeyboardButton[] = [
  {
    id: "escape",
    kind: "key",
    category: "special",
    accessibleLabel: "Escape",
    sequence: [{ type: "key", key: "Escape" }],
  },
  {
    id: "tab",
    kind: "key",
    category: "special",
    accessibleLabel: "Tab",
    sequence: [{ type: "key", key: "Tab" }],
  },
  {
    id: "git-status",
    kind: "shortcut",
    category: "shortcuts",
    accessibleLabel: "Git status shortcut",
    sequence: [{ type: "text", value: "git status" }],
  },
];

type ModifierInput = {
  activeModifiers: readonly CustomKeyboardModifier[];
  modifier: CustomKeyboardModifier;
};

const modifierCases = [
  {
    name: "adds Ctrl to an empty modifier latch",
    input: { activeModifiers: [], modifier: "ctrl" },
    assert: [returns<EmptyContext, CustomKeyboardModifier[]>(["ctrl"])],
  },
  {
    name: "removes Ctrl when the latched modifier is pressed again",
    input: { activeModifiers: ["ctrl"], modifier: "ctrl" },
    assert: [returns<EmptyContext, CustomKeyboardModifier[]>([])],
  },
  {
    name: "preserves Ctrl while adding another modifier",
    input: { activeModifiers: ["ctrl"], modifier: "alt" },
    assert: [returns<EmptyContext, CustomKeyboardModifier[]>(["ctrl", "alt"])],
  },
] satisfies readonly OperationCase<"default", ModifierInput, CustomKeyboardModifier[], EmptyContext>[];

const modifierTable: OperationTable<undefined, "default", ModifierInput, CustomKeyboardModifier[], EmptyContext> = {
  defaultFixture: noFixture(),
  cases: modifierCases,
  execute: (_fixture, input) => toggleCustomKeyboardModifier(input.activeModifiers, input.modifier),
  observe: () => ({}),
};

type InsertInput = {
  buttonIds: readonly string[];
  sourceId: string;
  targetId: string | null;
};

const insertCases = [
  {
    name: "inserts an existing key before the target and shifts the intervening keys",
    input: { buttonIds: ["escape", "tab", "git-status"], sourceId: "escape", targetId: "git-status" },
    assert: [returns<EmptyContext, string[]>(["tab", "escape", "git-status"])],
  },
  {
    name: "keeps the canonical order when an existing key has no valid target",
    input: { buttonIds: ["escape", "tab"], sourceId: "escape", targetId: "missing" },
    assert: [returns<EmptyContext, string[]>(["escape", "tab"])],
  },
] satisfies readonly OperationCase<"default", InsertInput, string[], EmptyContext>[];

const insertTable: OperationTable<undefined, "default", InsertInput, string[], EmptyContext> = {
  defaultFixture: noFixture(),
  cases: insertCases,
  execute: (_fixture, input) => insertButtonIdBeforeTarget(input.buttonIds, input.sourceId, input.targetId),
  observe: () => ({}),
};

type DeriveInput = {
  selectedButtonIds: readonly string[];
  libraryButtons: readonly CustomKeyboardButton[];
};

type DropState = {
  selectedButtonIds: readonly string[];
  shortcutButtonIds: readonly string[];
};

type DropInput = {
  state: DropState;
  source: CustomKeyboardDragSource;
  target: CustomKeyboardDropTarget;
};

type KeyboardLayoutInput = "abc" | "123";

type KeyboardLayoutObservation = {
  rows: readonly (readonly string[])[];
  bottomRow: readonly string[];
};

const keyboardLayoutCases = [
  {
    name: "uses two letter rows before the Shift row on the ABC keyboard",
    input: "abc" as const,
    assert: [
      returns<EmptyContext, KeyboardLayoutObservation>({
        rows: customKeyboardAbcRows,
        bottomRow: customKeyboardAbcLetterRow,
      }),
    ],
  },
  {
    name: "keeps ten keys in each base number row including double quote",
    input: "123" as const,
    assert: [
      returns<EmptyContext, KeyboardLayoutObservation>({
        rows: customKeyboardNumberRows.base,
        bottomRow: customKeyboardPunctuationRow,
      }),
    ],
  },
] satisfies readonly OperationCase<"default", KeyboardLayoutInput, KeyboardLayoutObservation, EmptyContext>[];

const keyboardLayoutTable: OperationTable<
  undefined,
  "default",
  KeyboardLayoutInput,
  KeyboardLayoutObservation,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: keyboardLayoutCases,
  execute: (_fixture, input) =>
    input === "abc"
      ? { rows: customKeyboardAbcRows, bottomRow: customKeyboardAbcLetterRow }
      : { rows: customKeyboardNumberRows.base, bottomRow: customKeyboardPunctuationRow },
  observe: () => ({}),
};

const dropCases = [
  {
    name: "inserts a selected key before the target through the shared keyboard drop operation",
    input: {
      state: { selectedButtonIds: ["letter-a", "escape", "git-status"], shortcutButtonIds: ["git-status"] },
      source: { buttonId: "letter-a", collection: "keyboard" },
      target: { type: "keyboard", targetButtonId: "git-status" },
    },
    assert: [
      returns<EmptyContext, DropState>({
        selectedButtonIds: ["escape", "letter-a", "git-status"],
        shortcutButtonIds: ["git-status"],
      }),
    ],
  },
  {
    name: "assigns an available regular key immediately before the drop target",
    input: {
      state: { selectedButtonIds: ["escape", "git-status"], shortcutButtonIds: ["git-status"] },
      source: { buttonId: "letter-a", collection: "library" },
      target: { type: "keyboard", targetButtonId: "git-status" },
    },
    assert: [
      returns<EmptyContext, DropState>({
        selectedButtonIds: ["escape", "letter-a", "git-status"],
        shortcutButtonIds: ["git-status"],
      }),
    ],
  },
  {
    name: "moves a shortcut card within the shortcut library using the same drop contract",
    input: {
      state: { selectedButtonIds: ["escape"], shortcutButtonIds: ["git-status", "npm-test", "clear-screen"] },
      source: { buttonId: "clear-screen", collection: "shortcut-library" },
      target: { type: "shortcut-library", targetIndex: 0 },
    },
    assert: [
      returns<EmptyContext, DropState>({
        selectedButtonIds: ["escape"],
        shortcutButtonIds: ["clear-screen", "git-status", "npm-test"],
      }),
    ],
  },
  {
    name: "ignores a stale custom keyboard drag source instead of assigning it again",
    input: {
      state: { selectedButtonIds: ["escape"], shortcutButtonIds: [] },
      source: { buttonId: "letter-a", collection: "keyboard" },
      target: { type: "keyboard", targetButtonId: "escape" },
    },
    assert: [
      returns<EmptyContext, DropState>({
        selectedButtonIds: ["escape"],
        shortcutButtonIds: [],
      }),
    ],
  },
] satisfies readonly OperationCase<"default", DropInput, DropState, EmptyContext>[];

const dropTable: OperationTable<undefined, "default", DropInput, DropState, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: dropCases,
  execute: (_fixture, input) => applyCustomKeyboardDrop(input.state, input.source, input.target),
  observe: () => ({}),
};

const deriveCases = [
  {
    name: "derives displayed buttons in canonical order and ignores stale ids",
    input: { selectedButtonIds: ["git-status", "missing", "escape"], libraryButtons: selectionLibrary },
    assert: [returns<EmptyContext, string[]>(["git-status", "escape"])],
  },
  {
    name: "derives no displayed buttons for an empty selection",
    input: { selectedButtonIds: [], libraryButtons: selectionLibrary },
    assert: [returns<EmptyContext, string[]>([])],
  },
] satisfies readonly OperationCase<"default", DeriveInput, string[], EmptyContext>[];

const deriveTable: OperationTable<undefined, "default", DeriveInput, string[], EmptyContext> = {
  defaultFixture: noFixture(),
  cases: deriveCases,
  execute: (_fixture, input) =>
    selectedButtonsFromIds(input.selectedButtonIds, input.libraryButtons).map((button) => button.id),
  observe: () => ({}),
};

type DefaultButtonInput = {
  buttonId: string;
  interaction?: CustomKeyboardButton["interaction"];
  terminalAction?: CustomKeyboardButton["terminalAction"];
};

const defaultButtonCases = [
  {
    name: "includes Delete in the default custom keyboard",
    input: { buttonId: "delete" },
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "includes the directional flick key in the default custom keyboard",
    input: { buttonId: "directional-flick", interaction: "directional-flick" },
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "includes the copy mode action in the default custom keyboard",
    input: { buttonId: "copy-mode", terminalAction: "enter-copy-mode" },
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "includes clipboard paste in the default custom keyboard",
    input: { buttonId: "paste-clipboard", terminalAction: "paste-from-clipboard" },
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "includes tmux buffer paste in the default custom keyboard",
    input: { buttonId: "paste-tmux-buffer", terminalAction: "paste-from-tmux-buffer" },
    assert: [returns<EmptyContext, boolean>(true)],
  },
] satisfies readonly OperationCase<"default", DefaultButtonInput, boolean, EmptyContext>[];

const defaultButtonTable: OperationTable<undefined, "default", DefaultButtonInput, boolean, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: defaultButtonCases,
  execute: (_fixture, input) =>
    defaultCustomKeyboardButtons.some(
      (button) =>
        button.id === input.buttonId &&
        (input.interaction === undefined || button.interaction === input.interaction) &&
        (input.terminalAction === undefined || button.terminalAction === input.terminalAction),
    ),
  observe: () => ({}),
};

type TerminalActionOptionObservation = {
  ids: readonly string[];
  actions: readonly string[];
};

const terminalActionOptionCases = [
  {
    name: "exposes all terminal actions to the custom keyboard library",
    input: {},
    assert: [
      returns<EmptyContext, TerminalActionOptionObservation>({
        ids: ["copy-mode", "paste-clipboard", "paste-tmux-buffer"],
        actions: ["enter-copy-mode", "paste-from-clipboard", "paste-from-tmux-buffer"],
      }),
    ],
  },
] satisfies readonly OperationCase<"default", {}, TerminalActionOptionObservation, EmptyContext>[];

const terminalActionOptionTable: OperationTable<
  undefined,
  "default",
  {},
  TerminalActionOptionObservation,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: terminalActionOptionCases,
  execute: () => ({
    ids: customKeyboardTerminalActionOptions.map((option) => option.id),
    actions: customKeyboardTerminalActionOptions.map((option) => option.action),
  }),
  observe: () => ({}),
};

type ShortcutDraftInput = {
  sequence: CustomKeyboardButton["sequence"];
};

const shortcutDraftCases = [
  {
    name: "rejects a shortcut draft without sequence tokens",
    input: { sequence: [] },
    assert: [returns<EmptyContext, boolean>(false)],
  },
  {
    name: "accepts a shortcut draft with one sequence token",
    input: { sequence: [{ type: "key", key: "Enter" }] },
    assert: [returns<EmptyContext, boolean>(true)],
  },
] satisfies readonly OperationCase<"default", ShortcutDraftInput, boolean, EmptyContext>[];

const shortcutDraftTable: OperationTable<undefined, "default", ShortcutDraftInput, boolean, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: shortcutDraftCases,
  execute: (_fixture, input) => isCustomKeyboardShortcutDraftValid(input),
  observe: () => ({}),
};

type ShiftLibraryObservation = {
  count: number;
  categories: readonly string[];
};

const shiftLibraryCases = [
  {
    name: "keeps one Shift entry in the ABC keyboard library",
    input: {},
    assert: [returns<EmptyContext, ShiftLibraryObservation>({ count: 1, categories: ["abc"] })],
  },
] satisfies readonly OperationCase<"default", {}, ShiftLibraryObservation, EmptyContext>[];

const shiftLibraryTable: OperationTable<undefined, "default", {}, ShiftLibraryObservation, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: shiftLibraryCases,
  execute: () => {
    const shiftButtons = customKeyboardButtonLibrary.filter((button) => button.id === "shift");
    return { count: shiftButtons.length, categories: shiftButtons.map((button) => button.category) };
  },
  observe: () => ({}),
};

type ParsedStateObservation = {
  selectedButtonIds: readonly string[];
  hasInvalidButton: boolean;
  hasInvalidTerminalAction: boolean;
  hasEscapeButton: boolean;
  shiftCategory: string | undefined;
};

const parsedStateCases = [
  {
    name: "drops a persisted button whose sequence contains an invalid token",
    input: {
      raw: JSON.stringify({
        selectedButtonIds: ["broken-shortcut", "escape"],
        libraryButtons: [
          {
            id: "broken-shortcut",
            kind: "shortcut",
            category: "shortcuts",
            accessibleLabel: "Broken shortcut",
            sequence: [null],
          },
        ],
      }),
    },
    assert: [
      returns<EmptyContext, ParsedStateObservation>({
        selectedButtonIds: ["escape"],
        hasInvalidButton: false,
        hasInvalidTerminalAction: false,
        hasEscapeButton: true,
        shiftCategory: "abc",
      }),
    ],
  },
  {
    name: "keeps the canonical ABC Shift entry over a stale persisted special entry",
    input: {
      raw: JSON.stringify({
        selectedButtonIds: ["shift"],
        libraryButtons: [
          {
            id: "shift",
            kind: "modifier",
            category: "special",
            icon: "control",
            label: "Shift",
            accessibleLabel: "Shift modifier",
            sequence: [],
            modifier: "shift",
          },
        ],
      }),
    },
    assert: [
      returns<EmptyContext, ParsedStateObservation>({
        selectedButtonIds: ["shift"],
        hasInvalidButton: false,
        hasInvalidTerminalAction: false,
        hasEscapeButton: true,
        shiftCategory: "abc",
      }),
    ],
  },
  {
    name: "drops a persisted button with an unknown terminal action",
    input: {
      raw: JSON.stringify({
        selectedButtonIds: ["broken-terminal-action", "escape"],
        libraryButtons: [
          {
            id: "broken-terminal-action",
            kind: "key",
            category: "special",
            accessibleLabel: "Broken terminal action",
            sequence: [],
            terminalAction: "unsupported-action",
          },
        ],
      }),
    },
    assert: [
      returns<EmptyContext, ParsedStateObservation>({
        selectedButtonIds: ["escape"],
        hasInvalidButton: false,
        hasInvalidTerminalAction: false,
        hasEscapeButton: true,
        shiftCategory: "abc",
      }),
    ],
  },
] satisfies readonly OperationCase<"default", { raw: string | null }, ParsedStateObservation, EmptyContext>[];

const parsedStateTable: OperationTable<
  undefined,
  "default",
  { raw: string | null },
  ParsedStateObservation,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: parsedStateCases,
  execute: (_fixture, input) => {
    const state = parseCustomKeyboardState(input.raw);
    return {
      selectedButtonIds: state.selectedButtonIds,
      hasInvalidButton: state.libraryButtons.some((button) => button.id === "broken-shortcut"),
      hasInvalidTerminalAction: state.libraryButtons.some((button) => button.id === "broken-terminal-action"),
      hasEscapeButton: state.libraryButtons.some((button) => button.id === "escape"),
      shiftCategory: state.libraryButtons.find((button) => button.id === "shift")?.category,
    };
  },
  observe: () => ({}),
};

describe("custom keyboard selection state", () => {
  runOperationTable(it, modifierTable);
  runOperationTable(it, keyboardLayoutTable);
  runOperationTable(it, insertTable);
  runOperationTable(it, deriveTable);
  runOperationTable(it, dropTable);
  runOperationTable(it, defaultButtonTable);
  runOperationTable(it, terminalActionOptionTable);
  runOperationTable(it, shortcutDraftTable);
  runOperationTable(it, shiftLibraryTable);
  runOperationTable(it, parsedStateTable);
});
