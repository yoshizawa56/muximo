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
  insertButtonIdBeforeTarget,
  isCustomKeyboardShortcutDraftValid,
  selectedButtonsFromIds,
  toggleCustomKeyboardModifier,
} from "./policy";
import {
  type CustomKeyboardButton,
  type CustomKeyboardDragSource,
  type CustomKeyboardDropTarget,
  type CustomKeyboardIcon,
  type CustomKeyboardModifier,
  type CustomKeyboardState,
  createCustomKeyboardProfile,
  customKeyboardButtonLibrary,
  customKeyboardTerminalActionOptions,
  defaultCustomKeyboardButtons,
  deleteCustomKeyboardProfile,
  duplicateCustomKeyboardProfile,
  isCustomKeyboardFixedButton,
  isCustomKeyboardProfileNameValid,
  parseCustomKeyboardState,
  resolveActiveProfileId,
  selectCustomKeyboardProfile,
  toggleCustomKeyboardProfileLink,
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
    name: "includes Enter in the default custom keyboard",
    input: { buttonId: "enter" },
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "includes Delete in the default custom keyboard",
    input: { buttonId: "delete" },
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "includes the exclamation mark in the default custom keyboard",
    input: { buttonId: "exclamation" },
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
  {
    name: "keeps the Git status shortcut out of the default custom keyboard",
    input: { buttonId: "git-status" },
    assert: [returns<EmptyContext, boolean>(false)],
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
    const profile = state.profiles.find((candidate) => candidate.id === "default");
    return {
      selectedButtonIds: profile?.selectedButtonIds ?? [],
      hasInvalidButton: profile?.libraryButtons.some((button) => button.id === "broken-shortcut") ?? false,
      hasInvalidTerminalAction:
        profile?.libraryButtons.some((button) => button.id === "broken-terminal-action") ?? false,
      hasEscapeButton: profile?.libraryButtons.some((button) => button.id === "escape") ?? false,
      shiftCategory: profile?.libraryButtons.find((button) => button.id === "shift")?.category,
    };
  },
  observe: () => ({}),
};

type ProfileStateParseObservation = {
  profileIds: readonly string[];
  activeProfileId: string;
  linkedProfileIds: readonly string[];
  defaultSelectedButtonIds: readonly string[];
  agentSelectedButtonIds: readonly string[];
  agentIcon: CustomKeyboardIcon;
  defaultFixedButtonIds: readonly string[];
};

const profileStateParseCases = [
  {
    name: "restores multiple profiles and workspace mapping from version two state",
    input: {
      raw: JSON.stringify({
        version: 2,
        profiles: [
          { id: "default", selectedButtonIds: ["copy-mode", "escape"] },
          { id: "agent", name: "Agent", icon: "camera", selectedButtonIds: ["copy-mode", "git-status"] },
        ],
        workspaceProfileIds: { "workspace-1": ["agent"] },
        activeProfileIdsByWorkspace: { "workspace-1": "agent" },
        globalActiveProfileId: "default",
      }),
    },
    assert: [
      returns<EmptyContext, ProfileStateParseObservation>({
        profileIds: ["default", "agent"],
        activeProfileId: "agent",
        linkedProfileIds: ["agent"],
        defaultSelectedButtonIds: ["escape"],
        agentSelectedButtonIds: ["git-status"],
        agentIcon: "camera",
        defaultFixedButtonIds: [],
      }),
    ],
  },
] satisfies readonly OperationCase<"default", { raw: string }, ProfileStateParseObservation, EmptyContext>[];

const profileStateParseTable: OperationTable<
  undefined,
  "default",
  { raw: string },
  ProfileStateParseObservation,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: profileStateParseCases,
  execute: (_fixture, input) => {
    const state = parseCustomKeyboardState(input.raw);
    const defaultProfile = state.profiles.find((profile) => profile.id === "default");
    const agentProfile = state.profiles.find((profile) => profile.id === "agent");
    return {
      profileIds: state.profiles.map((profile) => profile.id),
      activeProfileId: resolveActiveProfileId(state, "workspace-1"),
      linkedProfileIds: state.workspaceProfileIds["workspace-1"] ?? [],
      defaultSelectedButtonIds: defaultProfile?.selectedButtonIds ?? [],
      agentSelectedButtonIds: agentProfile?.selectedButtonIds ?? [],
      agentIcon: agentProfile?.icon ?? "terminal",
      defaultFixedButtonIds: (defaultProfile?.selectedButtonIds ?? []).filter(isCustomKeyboardFixedButton),
    };
  },
  observe: () => ({}),
};

const defaultProfileState = parseCustomKeyboardState(null);
const defaultProfile = defaultProfileState.profiles[0];
if (!defaultProfile) throw new Error("Default custom keyboard profile fixture is missing");
const agentProfile = {
  ...defaultProfile,
  id: "agent",
  name: "Agent",
  icon: "camera" as const,
  selectedButtonIds: [...defaultProfile.selectedButtonIds, "git-status"],
};
const unlinkedProfileState: CustomKeyboardState = {
  ...defaultProfileState,
  profiles: [defaultProfile, agentProfile],
};
const linkedProfileState: CustomKeyboardState = {
  ...defaultProfileState,
  profiles: [defaultProfile, agentProfile],
  workspaceProfileIds: { "workspace-1": [agentProfile.id] },
  activeProfileIdsByWorkspace: { "workspace-1": agentProfile.id },
  globalActiveProfileId: defaultProfile.id,
};

type ProfileNameInput = { name: string };
const profileNameCases = [
  {
    name: "accepts a short profile name",
    input: { name: "Agent" },
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "rejects an empty profile name",
    input: { name: "   " },
    assert: [returns<EmptyContext, boolean>(false)],
  },
  {
    name: "rejects a profile name containing a control character",
    input: { name: "Agent\nProfile" },
    assert: [returns<EmptyContext, boolean>(false)],
  },
] satisfies readonly OperationCase<"default", ProfileNameInput, boolean, EmptyContext>[];

const profileNameTable: OperationTable<undefined, "default", ProfileNameInput, boolean, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: profileNameCases,
  execute: (_fixture, input) => isCustomKeyboardProfileNameValid(input.name),
  observe: () => ({}),
};

type ProfileSelectionInput = {
  state: CustomKeyboardState;
  workspaceId: string | null;
  profileId: string;
};

type ProfileSelectionObservation = {
  activeProfileId: string;
  linkedProfileIds: readonly string[];
  workspaceOneLinkedProfileIds: readonly string[];
};

const profileSelectionCases = [
  {
    name: "selects a profile and links it to the workspace",
    input: { state: unlinkedProfileState, workspaceId: "workspace-1", profileId: agentProfile.id },
    assert: [
      returns<EmptyContext, ProfileSelectionObservation>({
        activeProfileId: agentProfile.id,
        linkedProfileIds: [agentProfile.id],
        workspaceOneLinkedProfileIds: [agentProfile.id],
      }),
    ],
  },
  {
    name: "restores a linked profile when resolving the workspace selection",
    input: { state: linkedProfileState, workspaceId: "workspace-1", profileId: agentProfile.id },
    assert: [
      returns<EmptyContext, ProfileSelectionObservation>({
        activeProfileId: agentProfile.id,
        linkedProfileIds: [agentProfile.id],
        workspaceOneLinkedProfileIds: [agentProfile.id],
      }),
    ],
  },
  {
    name: "falls back to Default when a workspace has no linked profile",
    input: { state: defaultProfileState, workspaceId: "workspace-1", profileId: "missing" },
    assert: [
      returns<EmptyContext, ProfileSelectionObservation>({
        activeProfileId: defaultProfile.id,
        linkedProfileIds: [],
        workspaceOneLinkedProfileIds: [],
      }),
    ],
  },
  {
    name: "allows the same profile to be linked to multiple workspaces",
    input: { state: linkedProfileState, workspaceId: "workspace-2", profileId: agentProfile.id },
    assert: [
      returns<EmptyContext, ProfileSelectionObservation>({
        activeProfileId: agentProfile.id,
        linkedProfileIds: [agentProfile.id],
        workspaceOneLinkedProfileIds: [agentProfile.id],
      }),
    ],
  },
] satisfies readonly OperationCase<"default", ProfileSelectionInput, ProfileSelectionObservation, EmptyContext>[];

const profileSelectionTable: OperationTable<
  undefined,
  "default",
  ProfileSelectionInput,
  ProfileSelectionObservation,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: profileSelectionCases,
  execute: (_fixture, input) => {
    const state = selectCustomKeyboardProfile(input.state, input.workspaceId, input.profileId);
    return {
      activeProfileId: resolveActiveProfileId(state, input.workspaceId),
      linkedProfileIds: input.workspaceId ? (state.workspaceProfileIds[input.workspaceId] ?? []) : [],
      workspaceOneLinkedProfileIds: state.workspaceProfileIds["workspace-1"] ?? [],
    };
  },
  observe: () => ({}),
};

type ProfileMutationInput = {
  state: CustomKeyboardState;
  workspaceId: string | null;
  profileId?: string;
  name?: string;
  icon?: CustomKeyboardIcon;
};

type ProfileMutationObservation = {
  profileIds: readonly string[];
  profileNames: readonly string[];
  activeProfileId: string;
  linkedProfileIds: readonly string[];
  defaultSelectedButtonIds: readonly string[];
};

const profileCreationCases = [
  {
    name: "creates a profile with the chosen icon and selects it for the workspace",
    input: { state: defaultProfileState, workspaceId: "workspace-1", name: "Agent", icon: "spark" as const },
    assert: [
      returns<EmptyContext, ProfileMutationObservation>({
        profileIds: ["default", "custom-keyboard-profile-2"],
        profileNames: ["Default", "Agent"],
        activeProfileId: "custom-keyboard-profile-2",
        linkedProfileIds: ["custom-keyboard-profile-2"],
        defaultSelectedButtonIds: defaultProfile.selectedButtonIds,
      }),
    ],
  },
] satisfies readonly OperationCase<"default", ProfileMutationInput, ProfileMutationObservation, EmptyContext>[];

const profileCreationTable: OperationTable<
  undefined,
  "default",
  ProfileMutationInput,
  ProfileMutationObservation,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: profileCreationCases,
  execute: (_fixture, input) =>
    observeProfileMutation(
      createCustomKeyboardProfile(input.state, input.workspaceId, {
        name: input.name ?? "",
        icon: input.icon ?? "terminal",
      }),
      input.workspaceId,
    ),
  observe: () => ({}),
};

const profileDuplicationCases = [
  {
    name: "duplicates a linked profile and selects the copy",
    input: { state: linkedProfileState, workspaceId: "workspace-1", profileId: agentProfile.id },
    assert: [
      returns<EmptyContext, ProfileMutationObservation>({
        profileIds: ["default", "agent", "custom-keyboard-profile-3"],
        profileNames: ["Default", "Agent", "Agent Copy"],
        activeProfileId: "custom-keyboard-profile-3",
        linkedProfileIds: ["agent", "custom-keyboard-profile-3"],
        defaultSelectedButtonIds: defaultProfile.selectedButtonIds,
      }),
    ],
  },
] satisfies readonly OperationCase<"default", ProfileMutationInput, ProfileMutationObservation, EmptyContext>[];

const profileDuplicationTable: OperationTable<
  undefined,
  "default",
  ProfileMutationInput,
  ProfileMutationObservation,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: profileDuplicationCases,
  execute: (_fixture, input) =>
    observeProfileMutation(
      duplicateCustomKeyboardProfile(input.state, input.workspaceId, input.profileId ?? ""),
      input.workspaceId,
    ),
  observe: () => ({}),
};

const profileDeletionCases = [
  {
    name: "deletes a linked profile and falls back to Default",
    input: { state: linkedProfileState, workspaceId: "workspace-1", profileId: agentProfile.id },
    assert: [
      returns<EmptyContext, ProfileMutationObservation>({
        profileIds: ["default"],
        profileNames: ["Default"],
        activeProfileId: "default",
        linkedProfileIds: [],
        defaultSelectedButtonIds: defaultProfile.selectedButtonIds,
      }),
    ],
  },
] satisfies readonly OperationCase<"default", ProfileMutationInput, ProfileMutationObservation, EmptyContext>[];

const profileDeletionTable: OperationTable<
  undefined,
  "default",
  ProfileMutationInput,
  ProfileMutationObservation,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: profileDeletionCases,
  execute: (_fixture, input) =>
    observeProfileMutation(deleteCustomKeyboardProfile(input.state, input.profileId ?? ""), input.workspaceId),
  observe: () => ({}),
};

function observeProfileMutation(state: CustomKeyboardState, workspaceId: string | null): ProfileMutationObservation {
  const activeProfileId = resolveActiveProfileId(state, workspaceId);
  const activeProfile = state.profiles.find((profile) => profile.id === activeProfileId);
  return {
    profileIds: state.profiles.map((profile) => profile.id),
    profileNames: state.profiles.map((profile) => profile.name),
    activeProfileId,
    linkedProfileIds: workspaceId ? (state.workspaceProfileIds[workspaceId] ?? []) : [],
    defaultSelectedButtonIds:
      activeProfile?.id === defaultProfile.id ? activeProfile.selectedButtonIds : defaultProfile.selectedButtonIds,
  };
}

type ProfileLinkInput = {
  state: CustomKeyboardState;
  workspaceId: string | null;
  profileId: string;
};

const profileLinkCases = [
  {
    name: "links an unlinked profile to a workspace",
    input: { state: unlinkedProfileState, workspaceId: "workspace-1", profileId: agentProfile.id },
    assert: [returns<EmptyContext, readonly string[]>([agentProfile.id])],
  },
  {
    name: "unlinks a linked profile from a workspace",
    input: { state: linkedProfileState, workspaceId: "workspace-1", profileId: agentProfile.id },
    assert: [returns<EmptyContext, readonly string[]>([])],
  },
] satisfies readonly OperationCase<"default", ProfileLinkInput, readonly string[], EmptyContext>[];

const profileLinkTable: OperationTable<undefined, "default", ProfileLinkInput, readonly string[], EmptyContext> = {
  defaultFixture: noFixture(),
  cases: profileLinkCases,
  execute: (_fixture, input) => {
    const state = toggleCustomKeyboardProfileLink(input.state, input.workspaceId, input.profileId);
    return input.workspaceId ? (state.workspaceProfileIds[input.workspaceId] ?? []) : [];
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
  runOperationTable(it, profileStateParseTable);
  runOperationTable(it, profileNameTable);
  runOperationTable(it, profileSelectionTable);
  runOperationTable(it, profileCreationTable);
  runOperationTable(it, profileDuplicationTable);
  runOperationTable(it, profileDeletionTable);
  runOperationTable(it, profileLinkTable);
});
