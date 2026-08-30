import { noFixture, type OperationCase, type OperationTable, returns, runOperationTable } from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  applyCustomKeyboardDrop,
  assignedKeyIds,
  type CustomKeyboardDropState,
  isCustomKeyboardShortcutDraftValid,
  resolveCustomKeyboardLayout,
  toggleCustomKeyboardModifier,
} from "./policy";
import {
  type CustomKeyboardDragSource,
  type CustomKeyboardDropTarget,
  type CustomKeyboardIcon,
  type CustomKeyboardKey,
  type CustomKeyboardLayout,
  type CustomKeyboardModifier,
  type CustomKeyboardProfile,
  type CustomKeyboardState,
  createCustomKeyboardProfile,
  customKeyboardTerminalActionOptions,
  defaultCustomKeyboardLayout,
  deleteCustomKeyboardProfile,
  duplicateCustomKeyboardProfile,
  isCustomKeyboardProfileNameValid,
  parseCustomKeyboardState,
  resolveActiveProfileId,
  selectCustomKeyboardProfile,
  toggleCustomKeyboardProfileLink,
} from "./viewmodel";

type EmptyContext = {};

function key(id: string, activation: CustomKeyboardKey["activation"]): CustomKeyboardKey {
  return { id, category: "special", accessibleLabel: id, activation };
}

function row(
  id: string,
  overflow: "scroll" | "stable",
  placements: CustomKeyboardLayout["rows"][number]["placements"],
): CustomKeyboardLayout["rows"][number] {
  return { id, overflow, placements };
}

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
] satisfies readonly OperationCase<
  "default",
  { activeModifiers: readonly CustomKeyboardModifier[]; modifier: CustomKeyboardModifier },
  CustomKeyboardModifier[],
  EmptyContext
>[];

const modifierTable: OperationTable<
  undefined,
  "default",
  { activeModifiers: readonly CustomKeyboardModifier[]; modifier: CustomKeyboardModifier },
  CustomKeyboardModifier[],
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: modifierCases,
  execute: (_fixture, input) => toggleCustomKeyboardModifier(input.activeModifiers, input.modifier),
  observe: () => ({}),
};

const layoutForDrop: CustomKeyboardLayout = {
  rows: [
    row("main", "scroll", [
      { keyId: "escape", density: "regular" },
      { keyId: "enter", density: "regular" },
    ]),
    row("utility", "stable", [
      { keyId: "directional-flick", density: "compact", flexGrow: 1 },
      { keyId: "profile-surface", density: "compact" },
    ]),
  ],
};

type DropInput = {
  state: CustomKeyboardDropState;
  source: CustomKeyboardDragSource;
  target: CustomKeyboardDropTarget;
};

const dropCases = [
  {
    name: "moves a keyboard key across rows while preserving its placement density",
    input: {
      state: { layout: layoutForDrop, shortcutKeyIds: [] },
      source: { keyId: "escape", collection: "keyboard", rowId: "main" },
      target: { type: "keyboard", rowId: "utility", targetKeyId: "profile-surface" },
    },
    assert: [
      returns<EmptyContext, CustomKeyboardDropState>({
        layout: {
          rows: [
            row("main", "scroll", [{ keyId: "enter", density: "regular" }]),
            row("utility", "stable", [
              { keyId: "directional-flick", density: "compact", flexGrow: 1 },
              { keyId: "escape", density: "regular" },
              { keyId: "profile-surface", density: "compact" },
            ]),
          ],
        },
        shortcutKeyIds: [],
      }),
    ],
  },
  {
    name: "assigns an available library key to the end of a stable row",
    input: {
      state: { layout: layoutForDrop, shortcutKeyIds: [] },
      source: { keyId: "letter-a", collection: "library" },
      target: { type: "keyboard", rowId: "utility", targetKeyId: null },
    },
    assert: [
      returns<EmptyContext, CustomKeyboardDropState>({
        layout: {
          rows: [
            row("main", "scroll", [
              { keyId: "escape", density: "regular" },
              { keyId: "enter", density: "regular" },
            ]),
            row("utility", "stable", [
              { keyId: "directional-flick", density: "compact", flexGrow: 1 },
              { keyId: "profile-surface", density: "compact" },
              { keyId: "letter-a", density: "regular" },
            ]),
          ],
        },
        shortcutKeyIds: [],
      }),
    ],
  },
  {
    name: "reorders shortcut library entries through the same drop contract",
    input: {
      state: { layout: layoutForDrop, shortcutKeyIds: ["git-status", "npm-test", "clear-screen"] },
      source: { keyId: "clear-screen", collection: "shortcut-library" },
      target: { type: "shortcut-library", targetIndex: 0 },
    },
    assert: [
      returns<EmptyContext, CustomKeyboardDropState>({
        layout: layoutForDrop,
        shortcutKeyIds: ["clear-screen", "git-status", "npm-test"],
      }),
    ],
  },
  {
    name: "ignores a stale keyboard drag source",
    input: {
      state: { layout: layoutForDrop, shortcutKeyIds: [] },
      source: { keyId: "missing", collection: "keyboard" },
      target: { type: "keyboard", rowId: "main", targetKeyId: "escape" },
    },
    assert: [returns<EmptyContext, CustomKeyboardDropState>({ layout: layoutForDrop, shortcutKeyIds: [] })],
  },
] satisfies readonly OperationCase<"default", DropInput, CustomKeyboardDropState, EmptyContext>[];

const dropTable: OperationTable<undefined, "default", DropInput, CustomKeyboardDropState, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: dropCases,
  execute: (_fixture, input) => applyCustomKeyboardDrop(input.state, input.source, input.target),
  observe: () => ({}),
};

type ResolvedLayoutObservation = {
  rows: readonly { id: string; overflow: string; keyIds: readonly string[] }[];
  assignedKeyIds: readonly string[];
};

const resolvedLayoutCases = [
  {
    name: "resolves every layout row from the shared key library",
    input: {},
    assert: [
      returns<EmptyContext, ResolvedLayoutObservation>({
        rows: [
          { id: "main", overflow: "scroll", keyIds: ["escape", "enter"] },
          { id: "utility", overflow: "stable", keyIds: ["profile-surface"] },
        ],
        assignedKeyIds: ["escape", "enter", "profile-surface"],
      }),
    ],
  },
] satisfies readonly OperationCase<"default", {}, ResolvedLayoutObservation, EmptyContext>[];

const resolvedLayoutTable: OperationTable<undefined, "default", {}, ResolvedLayoutObservation, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: resolvedLayoutCases,
  execute: () => {
    const layout: CustomKeyboardLayout = {
      rows: [
        row("main", "scroll", [
          { keyId: "escape", density: "regular" },
          { keyId: "enter", density: "regular" },
        ]),
        row("utility", "stable", [{ keyId: "profile-surface", density: "compact" }]),
      ],
    };
    const library = [
      key("escape", { type: "sequence", sequence: [{ type: "key", key: "Escape" }] }),
      key("enter", { type: "sequence", sequence: [{ type: "key", key: "Enter" }] }),
      key("profile-surface", { type: "surface", surface: "profile" }),
    ];
    const rows = resolveCustomKeyboardLayout(layout, library);
    return {
      rows: rows.map((currentRow) => ({
        id: currentRow.id,
        overflow: currentRow.overflow,
        keyIds: currentRow.items.map((item) => item.key.id),
      })),
      assignedKeyIds: assignedKeyIds(layout),
    };
  },
  observe: () => ({}),
};

type DefaultLayoutObservation = {
  mainKeyIds: readonly string[];
  utilityKeyIds: readonly string[];
  utilityOverflow: string | undefined;
  keyboardFlexGrow: number | undefined;
};

const defaultLayoutCases = [
  {
    name: "keeps Enter and exclamation in the default main row",
    input: {},
    assert: [
      returns<EmptyContext, DefaultLayoutObservation>({
        mainKeyIds: [
          "escape",
          "tab",
          "enter",
          "delete",
          "ctrl",
          "alt",
          "slash",
          "exclamation",
          "double-quote",
          "apostrophe",
          "pipe",
          "tilde",
          "at",
        ],
        utilityKeyIds: [
          "photo-library",
          "clipboard-surface",
          "toggle-standard-keyboard",
          "directional-flick",
          "profile-surface",
        ],
        utilityOverflow: "stable",
        keyboardFlexGrow: 1,
      }),
    ],
  },
] satisfies readonly OperationCase<"default", {}, DefaultLayoutObservation, EmptyContext>[];

const defaultLayoutTable: OperationTable<undefined, "default", {}, DefaultLayoutObservation, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: defaultLayoutCases,
  execute: () => {
    const main = defaultCustomKeyboardLayout.rows.find((currentRow) => currentRow.id === "main");
    const utility = defaultCustomKeyboardLayout.rows.find((currentRow) => currentRow.id === "utility");
    return {
      mainKeyIds: main?.placements.map((placement) => placement.keyId) ?? [],
      utilityKeyIds: utility?.placements.map((placement) => placement.keyId) ?? [],
      utilityOverflow: utility?.overflow,
      keyboardFlexGrow: utility?.placements.find((placement) => placement.keyId === "toggle-standard-keyboard")
        ?.flexGrow,
    };
  },
  observe: () => ({}),
};

type CatalogInput = { keyId: string };

const catalogCases = [
  {
    name: "has Enter in the built-in key catalog",
    input: { keyId: "enter" },
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "has exclamation in the built-in key catalog",
    input: { keyId: "exclamation" },
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "does not assign Git status to the default layout",
    input: { keyId: "git-status" },
    assert: [returns<EmptyContext, boolean>(false)],
  },
] satisfies readonly OperationCase<"default", CatalogInput, boolean, EmptyContext>[];

const catalogTable: OperationTable<undefined, "default", CatalogInput, boolean, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: catalogCases,
  execute: (_fixture, input) =>
    defaultCustomKeyboardLayout.rows.some((currentRow) =>
      currentRow.placements.some((placement) => placement.keyId === input.keyId),
    ),
  observe: () => ({}),
};

type TerminalActionObservation = { ids: readonly string[]; actions: readonly string[] };

const terminalActionCases = [
  {
    name: "exposes copy and paste actions as library keys",
    input: {},
    assert: [
      returns<EmptyContext, TerminalActionObservation>({
        ids: ["copy-mode", "paste-clipboard", "paste-tmux-buffer"],
        actions: ["enter-copy-mode", "paste-from-clipboard", "paste-from-tmux-buffer"],
      }),
    ],
  },
] satisfies readonly OperationCase<"default", {}, TerminalActionObservation, EmptyContext>[];

const terminalActionTable: OperationTable<undefined, "default", {}, TerminalActionObservation, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: terminalActionCases,
  execute: () => ({
    ids: customKeyboardTerminalActionOptions.map((option) => option.id),
    actions: customKeyboardTerminalActionOptions.map((option) => option.action),
  }),
  observe: () => ({}),
};

type ShortcutSequence = Extract<CustomKeyboardKey["activation"], { type: "sequence" }>["sequence"];

const shortcutDraftCases = [
  {
    name: "rejects a shortcut draft without sequence tokens",
    input: { sequence: [] as ShortcutSequence },
    assert: [returns<EmptyContext, boolean>(false)],
  },
  {
    name: "accepts a shortcut draft with one sequence token",
    input: { sequence: [{ type: "key", key: "Enter" }] as ShortcutSequence },
    assert: [returns<EmptyContext, boolean>(true)],
  },
] satisfies readonly OperationCase<"default", { sequence: ShortcutSequence }, boolean, EmptyContext>[];

const shortcutDraftTable: OperationTable<undefined, "default", { sequence: ShortcutSequence }, boolean, EmptyContext> =
  {
    defaultFixture: noFixture(),
    cases: shortcutDraftCases,
    execute: (_fixture, input) => isCustomKeyboardShortcutDraftValid(input),
    observe: () => ({}),
  };

type ParsedStateObservation = {
  profileIds: readonly string[];
  activeProfileId: string;
  linkedProfileIds: readonly string[];
  defaultMainKeyIds: readonly string[];
  agentMainKeyIds: readonly string[];
  agentShortcutKeyIds: readonly string[];
  agentIcon: CustomKeyboardIcon;
  utilityKeyIds: readonly string[];
  utilityFlexGrow: number | undefined;
};

const validV3State = JSON.stringify({
  version: 3,
  profiles: [
    { id: "default" },
    {
      id: "agent",
      name: "Agent",
      icon: "branch",
      libraryKeys: [
        {
          id: "agent-command",
          category: "shortcuts",
          accessibleLabel: "Agent command",
          activation: { type: "sequence", sequence: [{ type: "text", value: "agent" }] },
        },
      ],
      layout: {
        rows: [
          {
            id: "main",
            overflow: "scroll",
            placements: [{ keyId: "agent-command", density: "regular" }],
          },
          {
            id: "utility",
            overflow: "stable",
            placements: [{ keyId: "toggle-standard-keyboard", density: "compact", flexGrow: 2 }],
          },
        ],
      },
      shortcutKeyIds: ["agent-command"],
    },
  ],
  workspaceProfileIds: { "workspace-1": ["agent"] },
  activeProfileIdsByWorkspace: { "workspace-1": "agent" },
});

function legacyKey(id: string, category: "special" | "shortcuts", sequence: unknown[], extra: object = {}) {
  return {
    id,
    kind: category === "shortcuts" ? "shortcut" : "key",
    category,
    accessibleLabel: id,
    sequence,
    ...extra,
  };
}

const validV2State = JSON.stringify({
  version: 2,
  profiles: [
    {
      id: "default",
      selectedButtonIds: ["escape", "enter"],
      libraryButtons: [
        legacyKey("escape", "special", [{ type: "key", key: "Escape" }]),
        legacyKey("enter", "special", [{ type: "key", key: "Enter" }]),
      ],
    },
    {
      id: "agent",
      name: "Agent",
      icon: "camera",
      selectedButtonIds: ["git-status"],
      shortcutButtonIds: ["git-status"],
      libraryButtons: [
        legacyKey("git-status", "shortcuts", [
          { type: "text", value: "git status" },
          { type: "key", key: "Enter" },
        ]),
      ],
    },
  ],
  workspaceProfileIds: { "workspace-1": ["agent"] },
  activeProfileIdsByWorkspace: { "workspace-1": "agent" },
});

const invalidV3State = JSON.stringify({
  version: 3,
  profiles: [
    {
      id: "default",
      libraryKeys: [
        {
          id: "broken",
          category: "special",
          accessibleLabel: "Broken",
          activation: { type: "unsupported" },
        },
      ],
      layout: {
        rows: [
          {
            id: "main",
            overflow: "scroll",
            placements: [
              { keyId: "broken", density: "regular" },
              { keyId: "escape", density: "regular" },
            ],
          },
        ],
      },
    },
  ],
});

const parsedStateCases = [
  {
    name: "preserves v3 rows, custom keys, flex growth, and workspace profile selection",
    input: { raw: validV3State },
    assert: [
      returns<EmptyContext, ParsedStateObservation>({
        profileIds: ["default", "agent"],
        activeProfileId: "agent",
        linkedProfileIds: ["agent"],
        defaultMainKeyIds: [
          "escape",
          "tab",
          "enter",
          "delete",
          "ctrl",
          "alt",
          "slash",
          "exclamation",
          "double-quote",
          "apostrophe",
          "pipe",
          "tilde",
          "at",
        ],
        agentMainKeyIds: ["agent-command"],
        agentShortcutKeyIds: ["agent-command"],
        agentIcon: "branch",
        utilityKeyIds: ["toggle-standard-keyboard"],
        utilityFlexGrow: 2,
      }),
    ],
  },
  {
    name: "migrates v2 button selections into the current row layout",
    input: { raw: validV2State },
    assert: [
      returns<EmptyContext, ParsedStateObservation>({
        profileIds: ["default", "agent"],
        activeProfileId: "agent",
        linkedProfileIds: ["agent"],
        defaultMainKeyIds: ["escape", "enter"],
        agentMainKeyIds: ["git-status"],
        agentShortcutKeyIds: ["git-status"],
        agentIcon: "camera",
        utilityKeyIds: [
          "photo-library",
          "clipboard-surface",
          "toggle-standard-keyboard",
          "directional-flick",
          "profile-surface",
        ],
        utilityFlexGrow: 1,
      }),
    ],
  },
  {
    name: "drops invalid v3 activations before resolving the layout",
    input: { raw: invalidV3State },
    assert: [
      returns<EmptyContext, ParsedStateObservation>({
        profileIds: ["default"],
        activeProfileId: "default",
        linkedProfileIds: [],
        defaultMainKeyIds: ["escape"],
        agentMainKeyIds: [],
        agentShortcutKeyIds: [],
        agentIcon: "terminal",
        utilityKeyIds: [],
        utilityFlexGrow: undefined,
      }),
    ],
  },
] satisfies readonly OperationCase<"default", { raw: string }, ParsedStateObservation, EmptyContext>[];

const parsedStateTable: OperationTable<undefined, "default", { raw: string }, ParsedStateObservation, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: parsedStateCases,
  execute: (_fixture, input) => {
    const state = parseCustomKeyboardState(input.raw);
    const defaultProfile = state.profiles.find((profile) => profile.id === "default");
    const agentProfile = state.profiles.find((profile) => profile.id === "agent");
    const utilityRow = agentProfile?.layout.rows.find((currentRow) => currentRow.id === "utility");
    return {
      profileIds: state.profiles.map((profile) => profile.id),
      activeProfileId: resolveActiveProfileId(state, "workspace-1"),
      linkedProfileIds: state.workspaceProfileIds["workspace-1"] ?? [],
      defaultMainKeyIds:
        defaultProfile?.layout.rows
          .find((currentRow) => currentRow.id === "main")
          ?.placements.map((item) => item.keyId) ?? [],
      agentMainKeyIds:
        agentProfile?.layout.rows
          .find((currentRow) => currentRow.id === "main")
          ?.placements.map((item) => item.keyId) ?? [],
      agentShortcutKeyIds: agentProfile?.shortcutKeyIds ?? [],
      agentIcon: agentProfile?.icon ?? "terminal",
      utilityKeyIds: utilityRow?.placements.map((item) => item.keyId) ?? [],
      utilityFlexGrow: utilityRow?.placements.find((item) => item.keyId === "toggle-standard-keyboard")?.flexGrow,
    };
  },
  observe: () => ({}),
};

function profileStateWithAgent(): CustomKeyboardState {
  const state = parseCustomKeyboardState(null);
  const defaultProfile = state.profiles[0];
  if (!defaultProfile) throw new Error("Default custom keyboard profile fixture is missing");
  const agent: CustomKeyboardProfile = {
    ...defaultProfile,
    id: "agent",
    name: "Agent",
    icon: "spark",
    libraryKeys: defaultProfile.libraryKeys.map((key) => ({ ...key })),
    layout: {
      rows: defaultProfile.layout.rows.map((currentRow) => ({
        ...currentRow,
        placements: currentRow.placements.map((placement) => ({ ...placement })),
      })),
    },
    shortcutKeyIds: [...defaultProfile.shortcutKeyIds],
  };
  return { ...state, profiles: [...state.profiles, agent] };
}

type ProfileOperation =
  | { type: "select"; profileId: string }
  | { type: "create"; name: string; icon: CustomKeyboardIcon }
  | { type: "duplicate"; profileId: string }
  | { type: "delete"; profileId: string }
  | { type: "toggle-link"; profileId: string };

type ProfileObservation = {
  profileIds: readonly string[];
  profileNames: readonly string[];
  activeProfileId: string;
  linkedProfileIds: readonly string[];
};

function observeProfileState(state: CustomKeyboardState): ProfileObservation {
  return {
    profileIds: state.profiles.map((profile) => profile.id),
    profileNames: state.profiles.map((profile) => profile.name),
    activeProfileId: resolveActiveProfileId(state, "workspace-1"),
    linkedProfileIds: state.workspaceProfileIds["workspace-1"] ?? [],
  };
}

const profileCases = [
  {
    name: "selects a profile and links it to the workspace",
    input: { state: profileStateWithAgent(), operation: { type: "select", profileId: "agent" } as const },
    assert: [
      returns<EmptyContext, ProfileObservation>({
        profileIds: ["default", "agent"],
        profileNames: ["Default", "Agent"],
        activeProfileId: "agent",
        linkedProfileIds: ["agent"],
      }),
    ],
  },
  {
    name: "creates and activates a named profile",
    input: {
      state: parseCustomKeyboardState(null),
      operation: { type: "create", name: "Agent", icon: "spark" } as const,
    },
    assert: [
      returns<EmptyContext, ProfileObservation>({
        profileIds: ["default", "custom-keyboard-profile-2"],
        profileNames: ["Default", "Agent"],
        activeProfileId: "custom-keyboard-profile-2",
        linkedProfileIds: ["custom-keyboard-profile-2"],
      }),
    ],
  },
  {
    name: "duplicates a profile with its layout and library",
    input: { state: profileStateWithAgent(), operation: { type: "duplicate", profileId: "agent" } as const },
    assert: [
      returns<EmptyContext, ProfileObservation>({
        profileIds: ["default", "agent", "custom-keyboard-profile-3"],
        profileNames: ["Default", "Agent", "Agent Copy"],
        activeProfileId: "custom-keyboard-profile-3",
        linkedProfileIds: ["custom-keyboard-profile-3"],
      }),
    ],
  },
  {
    name: "deletes a profile and falls back to Default for its workspace",
    input: {
      state: {
        ...profileStateWithAgent(),
        workspaceProfileIds: { "workspace-1": ["agent"] },
        activeProfileIdsByWorkspace: { "workspace-1": "agent" },
      },
      operation: { type: "delete", profileId: "agent" } as const,
    },
    assert: [
      returns<EmptyContext, ProfileObservation>({
        profileIds: ["default"],
        profileNames: ["Default"],
        activeProfileId: "default",
        linkedProfileIds: [],
      }),
    ],
  },
  {
    name: "toggles a profile link without changing the active default",
    input: {
      state: { ...profileStateWithAgent(), activeProfileIdsByWorkspace: { "workspace-1": "default" } },
      operation: { type: "toggle-link", profileId: "agent" } as const,
    },
    assert: [
      returns<EmptyContext, ProfileObservation>({
        profileIds: ["default", "agent"],
        profileNames: ["Default", "Agent"],
        activeProfileId: "default",
        linkedProfileIds: ["agent"],
      }),
    ],
  },
] satisfies readonly OperationCase<
  "default",
  { state: CustomKeyboardState; operation: ProfileOperation },
  ProfileObservation,
  EmptyContext
>[];

const profileTable: OperationTable<
  undefined,
  "default",
  { state: CustomKeyboardState; operation: ProfileOperation },
  ProfileObservation,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: profileCases,
  execute: (_fixture, input) => {
    const { state, operation } = input;
    const nextState =
      operation.type === "select"
        ? selectCustomKeyboardProfile(state, "workspace-1", operation.profileId)
        : operation.type === "create"
          ? createCustomKeyboardProfile(state, "workspace-1", { name: operation.name, icon: operation.icon })
          : operation.type === "duplicate"
            ? duplicateCustomKeyboardProfile(state, "workspace-1", operation.profileId)
            : operation.type === "delete"
              ? deleteCustomKeyboardProfile(state, operation.profileId)
              : toggleCustomKeyboardProfileLink(state, "workspace-1", operation.profileId);
    return observeProfileState(nextState);
  },
  observe: () => ({}),
};

const profileNameCases = [
  {
    name: "accepts a trimmed profile name",
    input: " Agent ",
    assert: [returns<EmptyContext, boolean>(true)],
  },
  {
    name: "rejects an empty profile name",
    input: "   ",
    assert: [returns<EmptyContext, boolean>(false)],
  },
  {
    name: "rejects a profile name containing a newline",
    input: "Agent\nShell",
    assert: [returns<EmptyContext, boolean>(false)],
  },
] satisfies readonly OperationCase<"default", string, boolean, EmptyContext>[];

const profileNameTable: OperationTable<undefined, "default", string, boolean, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: profileNameCases,
  execute: (_fixture, input) => isCustomKeyboardProfileNameValid(input),
  observe: () => ({}),
};

describe("custom keyboard unified key model", () => {
  runOperationTable(it, modifierTable);
  runOperationTable(it, dropTable);
  runOperationTable(it, resolvedLayoutTable);
  runOperationTable(it, defaultLayoutTable);
  runOperationTable(it, catalogTable);
  runOperationTable(it, terminalActionTable);
  runOperationTable(it, shortcutDraftTable);
  runOperationTable(it, parsedStateTable);
  runOperationTable(it, profileTable);
  runOperationTable(it, profileNameTable);
});
