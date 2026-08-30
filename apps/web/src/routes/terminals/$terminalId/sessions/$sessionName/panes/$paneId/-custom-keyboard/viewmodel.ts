import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  applyCustomKeyboardDrop,
  assignedKeyIds,
  isCustomKeyboardShortcutDraftValid,
  keysFromIds,
  removeKeyFromLayout,
  resolveCustomKeyboardLayout,
  toggleCustomKeyboardModifier,
} from "./policy";
import { type CustomKeyboardStorage, createCustomKeyboardStorage } from "./storage";
import type { CustomKeyboardTerminalAction } from "./terminal-actions";
import { isCustomKeyboardTerminalAction } from "./terminal-actions";

export { CUSTOM_KEYBOARD_STORAGE_KEY } from "./storage";
export type { CustomKeyboardTerminalAction } from "./terminal-actions";

export type CustomKeyboardModifier = "ctrl" | "alt" | "shift";

export type CustomKeyboardSequenceToken =
  | {
      type: "text";
      value: string;
    }
  | {
      type: "key";
      key: string;
      modifiers?: readonly CustomKeyboardModifier[];
    };

export type CustomKeyboardSequence = readonly CustomKeyboardSequenceToken[];

export type CustomKeyboardNativeAction = "pick-photo" | "capture-photo" | "scan-qr" | "toggle-standard-keyboard";

export type CustomKeyboardNativeFileAction = Extract<CustomKeyboardNativeAction, "pick-photo" | "capture-photo">;

export type CustomKeyboardKeyCategory = "abc" | "123" | "special" | "shortcuts";

export type CustomKeyboardIcon =
  | "escape"
  | "tab"
  | "control"
  | "option"
  | "slash"
  | "quote"
  | "apostrophe"
  | "pipe"
  | "tilde"
  | "at"
  | "dollar"
  | "ampersand"
  | "hash"
  | "equals"
  | "percent"
  | "brackets"
  | "braces"
  | "shortcut"
  | "terminal"
  | "directional-flick"
  | "branch"
  | "bolt"
  | "spark"
  | "command"
  | "prompt"
  | "copy"
  | "paste"
  | "select-all"
  | "clear"
  | "search"
  | "refresh"
  | "play"
  | "stop"
  | "send"
  | "check"
  | "close"
  | "plus"
  | "minus"
  | "camera"
  | "photo"
  | "microphone"
  | "screenshot"
  | "share"
  | "clipboard"
  | "keyboard"
  | "settings"
  | "globe"
  | "flashlight"
  | "phone"
  | "qr"
  | "volume-up"
  | "volume-down"
  | "lock"
  | "letter"
  | "number"
  | "special-key";

export type CustomKeyboardIconCategory = "terminal" | "symbols" | "actions" | "device";

export type CustomKeyboardKeyActivation =
  | {
      type: "sequence";
      sequence: CustomKeyboardSequence;
    }
  | {
      type: "modifier";
      modifier: CustomKeyboardModifier;
    }
  | {
      type: "native";
      action: CustomKeyboardNativeAction;
    }
  | {
      type: "terminal";
      action: CustomKeyboardTerminalAction;
    }
  | {
      type: "directional-flick";
    }
  | {
      type: "surface";
      surface: CustomKeyboardSurfaceId;
    };

export type CustomKeyboardSurfaceId = "clipboard" | "profile";

export type CustomKeyboardKey = {
  id: string;
  category: CustomKeyboardKeyCategory;
  icon?: CustomKeyboardIcon;
  label?: string;
  accessibleLabel: string;
  activation: CustomKeyboardKeyActivation;
};

export type CustomKeyboardLayoutPlacement = {
  keyId: string;
  density: "regular" | "compact";
  flexGrow?: number;
};

export type CustomKeyboardLayoutRow = {
  id: string;
  overflow: "scroll" | "stable";
  placements: CustomKeyboardLayoutPlacement[];
};

export type CustomKeyboardLayout = {
  rows: CustomKeyboardLayoutRow[];
};

export type CustomKeyboardResolvedLayoutItem = CustomKeyboardLayoutPlacement & {
  key: CustomKeyboardKey;
};

export type CustomKeyboardResolvedLayoutRow = Omit<CustomKeyboardLayoutRow, "placements"> & {
  items: CustomKeyboardResolvedLayoutItem[];
};

export type CustomKeyboardProfile = {
  id: string;
  name: string;
  icon: CustomKeyboardIcon;
  layout: CustomKeyboardLayout;
  libraryKeys: CustomKeyboardKey[];
  shortcutKeyIds: string[];
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
};

export type CustomKeyboardSurfaceViewModel = {
  id: CustomKeyboardSurfaceId;
  keys: readonly CustomKeyboardKey[];
};

export type CustomKeyboardProfileSummary = {
  id: string;
  name: string;
  icon: CustomKeyboardIcon;
  linked: boolean;
};

export type CustomKeyboardDragCollection = "keyboard" | "library" | "shortcut-library";

export type CustomKeyboardDragSource = {
  keyId: string;
  collection: CustomKeyboardDragCollection;
  rowId?: string;
};

export type CustomKeyboardDropTarget =
  | {
      type: "keyboard";
      rowId: string;
      targetKeyId: string | null;
    }
  | {
      type: "shortcut-library";
      targetIndex: number;
    };

export type CustomKeyboardShortcutDraft = {
  icon: CustomKeyboardIcon;
  sequence: CustomKeyboardSequence;
};

export type CustomKeyboardFlickDirection = "up" | "down" | "left" | "right";

export type CustomKeyboardViewModel = {
  rows: readonly CustomKeyboardResolvedLayoutRow[];
  surfaces: readonly CustomKeyboardSurfaceViewModel[];
  activeModifiers: readonly CustomKeyboardModifier[];
  nativeKeyboardVisible: boolean;
  activeProfile: CustomKeyboardProfileSummary;
  profiles: readonly CustomKeyboardProfileSummary[];
  workspaceId: string | null;
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
  onSelectProfile: (profileId: string) => void;
  onActivateKey: (key: CustomKeyboardKey) => void;
  onDirectionalFlick: (direction: CustomKeyboardFlickDirection) => void;
  onNativeFileSelected: (action: CustomKeyboardNativeFileAction, file: File) => void;
  onKeepNativeKeyboardOpen: () => void;
  onToggleNativeKeyboard: () => void;
};

export type CustomKeyboardSettingsViewModel = {
  rows: readonly CustomKeyboardResolvedLayoutRow[];
  availableKeys: readonly CustomKeyboardKey[];
  shortcutKeys: readonly CustomKeyboardKey[];
  activeProfile: CustomKeyboardProfileSummary;
  profiles: readonly CustomKeyboardProfileSummary[];
  linkedProfileIds: readonly string[];
  workspaceId: string | null;
  assignedKeyIds: readonly string[];
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
  onSelectProfile: (profileId: string) => void;
  onCreateProfile: (input: { name: string; icon: CustomKeyboardIcon }) => void;
  onDuplicateProfile: (profileId: string) => void;
  onRenameProfile: (profileId: string, name: string) => void;
  onDeleteProfile: (profileId: string) => void;
  onSetProfileIcon: (profileId: string, icon: CustomKeyboardIcon) => void;
  onToggleProfileLink: (profileId: string) => void;
  onDrop: (source: CustomKeyboardDragSource, target: CustomKeyboardDropTarget) => void;
  onRemoveKey: (keyId: string) => void;
  onRegisterShortcut: (draft: CustomKeyboardShortcutDraft) => void;
  onUpdateShortcut: (keyId: string, draft: CustomKeyboardShortcutDraft) => void;
  onDeleteShortcut: (keyId: string) => void;
  onRepeatStartDelayChange: (startDelayMs: number) => void;
  onRepeatIntervalChange: (intervalMs: number) => void;
};

export type CustomKeyboardControllerOptions = {
  workspaceId: string | null;
  nativeKeyboardVisible: boolean;
  activeModifiers?: readonly CustomKeyboardModifier[];
  onActiveModifiersChange?: (modifiers: readonly CustomKeyboardModifier[]) => void;
  onSequence: (sequence: CustomKeyboardSequence, activeModifiers: readonly CustomKeyboardModifier[]) => void;
  onKeyEffect?: () => void;
  onNativeAction?: (action: CustomKeyboardNativeAction) => void;
  onTerminalAction: (action: CustomKeyboardTerminalAction) => void;
  onNativeFileSelected?: (action: CustomKeyboardNativeFileAction, file: File) => void;
  onKeepNativeKeyboardOpen?: () => void;
  onNativeKeyboardToggle: () => void;
};

export type CustomKeyboardController = {
  keyboard: CustomKeyboardViewModel;
  settings: CustomKeyboardSettingsViewModel;
};

export const customKeyboardIconOptions: readonly {
  value: CustomKeyboardIcon;
  glyph: string;
  label: string;
  category: CustomKeyboardIconCategory;
}[] = [
  { value: "escape", glyph: "ESC", label: "Escape", category: "terminal" },
  { value: "tab", glyph: "⇥", label: "Tab", category: "terminal" },
  { value: "control", glyph: "⌃", label: "Control", category: "terminal" },
  { value: "option", glyph: "⌥", label: "Option", category: "terminal" },
  { value: "shortcut", glyph: "⌁", label: "Shortcut", category: "terminal" },
  { value: "directional-flick", glyph: "◎", label: "Arrow pad", category: "terminal" },
  { value: "terminal", glyph: ">_", label: "Terminal", category: "terminal" },
  { value: "branch", glyph: "⎇", label: "Branch", category: "terminal" },
  { value: "bolt", glyph: "ϟ", label: "Bolt", category: "terminal" },
  { value: "spark", glyph: "✦", label: "Spark", category: "terminal" },
  { value: "command", glyph: "⌘", label: "Command", category: "terminal" },
  { value: "prompt", glyph: "$", label: "Prompt", category: "terminal" },
  { value: "slash", glyph: "/", label: "Slash", category: "symbols" },
  { value: "quote", glyph: '"', label: "Double quote", category: "symbols" },
  { value: "apostrophe", glyph: "'", label: "Apostrophe", category: "symbols" },
  { value: "pipe", glyph: "|", label: "Pipe", category: "symbols" },
  { value: "tilde", glyph: "~", label: "Tilde", category: "symbols" },
  { value: "at", glyph: "@", label: "At sign", category: "symbols" },
  { value: "dollar", glyph: "$", label: "Dollar sign", category: "symbols" },
  { value: "ampersand", glyph: "&", label: "Ampersand", category: "symbols" },
  { value: "hash", glyph: "#", label: "Hash", category: "symbols" },
  { value: "equals", glyph: "=", label: "Equals", category: "symbols" },
  { value: "percent", glyph: "%", label: "Percent", category: "symbols" },
  { value: "brackets", glyph: "[ ]", label: "Brackets", category: "symbols" },
  { value: "braces", glyph: "{ }", label: "Braces", category: "symbols" },
  { value: "letter", glyph: "A", label: "Letter", category: "actions" },
  { value: "number", glyph: "123", label: "Number", category: "actions" },
  { value: "special-key", glyph: "⌨", label: "Special key", category: "actions" },
  { value: "copy", glyph: "⧉", label: "Copy", category: "actions" },
  { value: "paste", glyph: "⎘", label: "Paste", category: "actions" },
  { value: "select-all", glyph: "☷", label: "Select all", category: "actions" },
  { value: "clear", glyph: "⌫", label: "Clear", category: "actions" },
  { value: "search", glyph: "⌕", label: "Search", category: "actions" },
  { value: "refresh", glyph: "↻", label: "Refresh", category: "actions" },
  { value: "play", glyph: "▶", label: "Play", category: "actions" },
  { value: "stop", glyph: "■", label: "Stop", category: "actions" },
  { value: "send", glyph: "➤", label: "Send", category: "actions" },
  { value: "check", glyph: "✓", label: "Check", category: "actions" },
  { value: "close", glyph: "×", label: "Close", category: "actions" },
  { value: "plus", glyph: "+", label: "Plus", category: "actions" },
  { value: "minus", glyph: "−", label: "Minus", category: "actions" },
  { value: "camera", glyph: "◉", label: "Camera", category: "device" },
  { value: "photo", glyph: "▧", label: "Photo library", category: "device" },
  { value: "microphone", glyph: "◒", label: "Microphone", category: "device" },
  { value: "screenshot", glyph: "▧", label: "Screenshot", category: "device" },
  { value: "share", glyph: "↗", label: "Share", category: "device" },
  { value: "clipboard", glyph: "▣", label: "Clipboard", category: "device" },
  { value: "keyboard", glyph: "⌨", label: "Keyboard", category: "device" },
  { value: "settings", glyph: "⚙", label: "Settings", category: "device" },
  { value: "globe", glyph: "◎", label: "Globe", category: "device" },
  { value: "flashlight", glyph: "☼", label: "Flashlight", category: "device" },
  { value: "phone", glyph: "☎", label: "Phone", category: "device" },
  { value: "qr", glyph: "▦", label: "QR scanner", category: "device" },
  { value: "volume-up", glyph: "))", label: "Volume up", category: "device" },
  { value: "volume-down", glyph: ")", label: "Volume down", category: "device" },
  { value: "lock", glyph: "⌑", label: "Lock", category: "device" },
];

export const DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID = "default";

export const customKeyboardIconCategories: readonly {
  value: CustomKeyboardIconCategory;
  label: string;
}[] = [
  { value: "terminal", label: "Terminal" },
  { value: "symbols", label: "Symbols" },
  { value: "actions", label: "Actions" },
  { value: "device", label: "Device" },
];

export type CustomKeyboardSpecialKeyDefinition = {
  id: string;
  key: string;
  label?: string;
  accessibleLabel: string;
  icon?: CustomKeyboardIcon;
};

export const customKeyboardSpecialKeyOptions: readonly CustomKeyboardSpecialKeyDefinition[] = [
  { id: "escape", key: "Escape", accessibleLabel: "Escape", icon: "escape" },
  { id: "tab", key: "Tab", label: "Tab", accessibleLabel: "Tab", icon: "tab" },
  { id: "enter", key: "Enter", label: "Enter", accessibleLabel: "Enter" },
  { id: "backspace", key: "Backspace", label: "Bksp", accessibleLabel: "Backspace" },
  { id: "delete", key: "Delete", label: "Del", accessibleLabel: "Delete" },
  { id: "home", key: "Home", label: "Home", accessibleLabel: "Home" },
  { id: "end", key: "End", label: "End", accessibleLabel: "End" },
  { id: "page-up", key: "PageUp", label: "PgUp", accessibleLabel: "Page up" },
  { id: "page-down", key: "PageDown", label: "PgDn", accessibleLabel: "Page down" },
];

export type CustomKeyboardSpecialModifierDefinition = {
  id: string;
  modifier: CustomKeyboardModifier;
  icon: CustomKeyboardIcon;
  label: string;
  accessibleLabel: string;
};

export const customKeyboardSpecialModifierOptions: readonly CustomKeyboardSpecialModifierDefinition[] = [
  { id: "ctrl", modifier: "ctrl", icon: "control", label: "Ctrl", accessibleLabel: "Control modifier" },
  { id: "alt", modifier: "alt", icon: "option", label: "Alt", accessibleLabel: "Alt modifier" },
  { id: "shift", modifier: "shift", icon: "control", label: "Shift", accessibleLabel: "Shift modifier" },
];

export type CustomKeyboardTerminalActionDefinition = {
  id: string;
  action: CustomKeyboardTerminalAction;
  icon: CustomKeyboardIcon;
  label: string;
  accessibleLabel: string;
};

export const customKeyboardTerminalActionOptions: readonly CustomKeyboardTerminalActionDefinition[] = [
  {
    id: "copy-mode",
    action: "enter-copy-mode",
    icon: "copy",
    label: "COPY",
    accessibleLabel: "Enter tmux copy mode",
  },
  {
    id: "paste-clipboard",
    action: "paste-from-clipboard",
    icon: "paste",
    label: "PASTE",
    accessibleLabel: "Paste from clipboard",
  },
  {
    id: "paste-tmux-buffer",
    action: "paste-from-tmux-buffer",
    icon: "clipboard",
    label: "TMUX",
    accessibleLabel: "Paste from tmux buffer",
  },
];

function specialKeyButton(id: string): CustomKeyboardKey {
  const definition = customKeyboardSpecialKeyOptions.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown special key: ${id}`);
  return {
    id: definition.id,
    category: "special",
    icon: definition.icon,
    label: definition.label,
    accessibleLabel: definition.accessibleLabel,
    activation: { type: "sequence", sequence: keySequence(definition.key) },
  };
}

function specialModifierButton(id: string): CustomKeyboardKey {
  const definition = customKeyboardSpecialModifierOptions.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown special modifier: ${id}`);
  return {
    id: definition.id,
    category: "special",
    icon: definition.icon,
    label: definition.label,
    accessibleLabel: definition.accessibleLabel,
    activation: { type: "modifier", modifier: definition.modifier },
  };
}

function terminalActionButton(id: string): CustomKeyboardKey {
  const definition = customKeyboardTerminalActionOptions.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown terminal action: ${id}`);
  return {
    id: definition.id,
    category: "special",
    icon: definition.icon,
    label: definition.label,
    accessibleLabel: definition.accessibleLabel,
    activation: { type: "terminal", action: definition.action },
  };
}

const customKeyboardSurfaceKeys: readonly CustomKeyboardKey[] = [
  {
    id: "clipboard-surface",
    category: "special",
    icon: "clipboard",
    label: "CLIP",
    accessibleLabel: "Open copy and paste actions",
    activation: { type: "surface", surface: "clipboard" },
  },
  {
    id: "toggle-standard-keyboard",
    category: "special",
    icon: "keyboard",
    label: "KEYBOARD",
    accessibleLabel: "Show or hide the standard keyboard",
    activation: { type: "native", action: "toggle-standard-keyboard" },
  },
  {
    id: "profile-surface",
    category: "special",
    icon: "settings",
    label: "PROFILE",
    accessibleLabel: "Open custom keyboard profiles and settings",
    activation: { type: "surface", surface: "profile" },
  },
];

const nativeCustomKeyboardKeys: readonly CustomKeyboardKey[] = [
  {
    id: "camera",
    category: "special",
    icon: "camera",
    label: "CAM",
    accessibleLabel: "Open camera",
    activation: { type: "native", action: "capture-photo" },
  },
  {
    id: "photo-library",
    category: "special",
    icon: "plus",
    label: "ADD",
    accessibleLabel: "Add image",
    activation: { type: "native", action: "pick-photo" },
  },
];

export const defaultCustomKeyboardKeys: readonly CustomKeyboardKey[] = [
  specialKeyButton("escape"),
  specialKeyButton("tab"),
  specialKeyButton("enter"),
  specialKeyButton("delete"),
  {
    id: "directional-flick",
    category: "special",
    icon: "directional-flick",
    label: "Arrows",
    accessibleLabel: "Arrow pad",
    activation: { type: "directional-flick" },
  },
  specialModifierButton("ctrl"),
  specialModifierButton("alt"),
  terminalActionButton("copy-mode"),
  terminalActionButton("paste-clipboard"),
  terminalActionButton("paste-tmux-buffer"),
  {
    id: "slash",
    category: "123",
    icon: "slash",
    accessibleLabel: "Slash",
    activation: { type: "sequence", sequence: textSequence("/") },
  },
  {
    id: "exclamation",
    category: "123",
    icon: "number",
    label: "!",
    accessibleLabel: "Exclamation mark",
    activation: { type: "sequence", sequence: textSequence("!") },
  },
  {
    id: "double-quote",
    category: "123",
    icon: "quote",
    accessibleLabel: "Double quote",
    activation: { type: "sequence", sequence: textSequence('"') },
  },
  {
    id: "apostrophe",
    category: "123",
    icon: "apostrophe",
    accessibleLabel: "Apostrophe",
    activation: { type: "sequence", sequence: textSequence("'") },
  },
  {
    id: "pipe",
    category: "123",
    icon: "pipe",
    accessibleLabel: "Pipe",
    activation: { type: "sequence", sequence: textSequence("|") },
  },
  {
    id: "tilde",
    category: "123",
    icon: "tilde",
    accessibleLabel: "Tilde",
    activation: { type: "sequence", sequence: textSequence("~") },
  },
  {
    id: "at",
    category: "123",
    icon: "at",
    accessibleLabel: "At sign",
    activation: { type: "sequence", sequence: textSequence("@") },
  },
  ...customKeyboardSurfaceKeys,
];

const alphabetCustomKeyboardKeys: readonly CustomKeyboardKey[] = [..."qwertyuiopasdfghjklzxcvbnm"].map((key) => ({
  id: `letter-${key}`,
  category: "abc",
  icon: "letter",
  label: key,
  accessibleLabel: `Letter ${key.toUpperCase()}`,
  activation: { type: "sequence", sequence: [keyToken(key)] },
}));

const numberCustomKeyboardKeys: readonly CustomKeyboardKey[] = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "0",
  "#",
  "$",
  "&",
  "@",
  "=",
  "-",
  "/",
  "+",
  "*",
  "?",
  "!",
  ":",
  ";",
  "(",
  ")",
  ",",
  ".",
  "'",
  '"',
].map((value) => ({
  id: `number-${value}`,
  category: "123",
  icon: "number",
  label: value,
  accessibleLabel: `Key ${value}`,
  activation: { type: "sequence", sequence: [textToken(value)] },
}));

const numberSymbolCustomKeyboardKeys: readonly CustomKeyboardKey[] = [
  ["left-bracket", "[", "Left bracket"],
  ["right-bracket", "]", "Right bracket"],
  ["left-brace", "{", "Left brace"],
  ["right-brace", "}", "Right brace"],
  ["percent", "%", "Percent"],
  ["caret", "^", "Caret"],
  ["underscore", "_", "Underscore"],
  ["backslash", "\\", "Backslash"],
  ["less-than", "<", "Less-than"],
  ["greater-than", ">", "Greater-than"],
  ["euro", "€", "Euro sign"],
  ["pound", "£", "Pound sign"],
  ["yen", "¥", "Yen sign"],
  ["bullet", "•", "Bullet"],
].map(([id, value, accessibleLabel]) => ({
  id: `number-${id}`,
  category: "123",
  icon: "number",
  label: value,
  accessibleLabel,
  activation: { type: "sequence", sequence: [textToken(value)] },
}));

const builtInShortcutKeys: readonly CustomKeyboardKey[] = [
  {
    id: "git-status",
    category: "shortcuts",
    icon: "branch",
    accessibleLabel: "Git status shortcut",
    activation: { type: "sequence", sequence: [textToken("git status"), keyToken("Enter")] },
  },
  {
    id: "npm-test",
    category: "shortcuts",
    icon: "bolt",
    accessibleLabel: "Run Bun test shortcut",
    activation: { type: "sequence", sequence: [textToken("bun test"), keyToken("Enter")] },
  },
  {
    id: "clear-screen",
    category: "shortcuts",
    icon: "terminal",
    accessibleLabel: "Clear terminal shortcut",
    activation: { type: "sequence", sequence: [textToken("clear"), keyToken("Enter")] },
  },
];

const shiftCustomKeyboardKey = { ...specialModifierButton("shift"), category: "abc" as const };

export const customKeyboardKeyLibrary: readonly CustomKeyboardKey[] = uniqueKeys([
  ...defaultCustomKeyboardKeys,
  shiftCustomKeyboardKey,
  ...alphabetCustomKeyboardKeys,
  ...numberCustomKeyboardKeys,
  ...numberSymbolCustomKeyboardKeys,
  ...customKeyboardSpecialKeyOptions.map((definition) => specialKeyButton(definition.id)),
  ...customKeyboardSpecialModifierOptions
    .filter((definition) => definition.id !== "shift")
    .map((definition) => specialModifierButton(definition.id)),
  ...customKeyboardTerminalActionOptions.map((definition) => terminalActionButton(definition.id)),
  ...nativeCustomKeyboardKeys,
  ...builtInShortcutKeys,
]);

export const customKeyboardSurfaceDefinitions: readonly {
  id: CustomKeyboardSurfaceId;
  keyIds: readonly string[];
}[] = [
  { id: "clipboard", keyIds: ["copy-mode", "paste-clipboard", "paste-tmux-buffer"] },
  { id: "profile", keyIds: [] },
];

const defaultUtilityKeyIds = new Set([
  "photo-library",
  "clipboard-surface",
  "toggle-standard-keyboard",
  "directional-flick",
  "profile-surface",
]);
const defaultSurfaceActionKeyIds = new Set(["copy-mode", "paste-clipboard", "paste-tmux-buffer"]);

export const defaultCustomKeyboardLayout: CustomKeyboardLayout = {
  rows: [
    {
      id: "main",
      overflow: "scroll",
      placements: defaultCustomKeyboardKeys
        .filter((key) => !defaultUtilityKeyIds.has(key.id) && !defaultSurfaceActionKeyIds.has(key.id))
        .map((key) => ({ keyId: key.id, density: "regular" as const })),
    },
    {
      id: "utility",
      overflow: "stable",
      placements: [
        { keyId: "photo-library", density: "compact" },
        { keyId: "clipboard-surface", density: "compact" },
        { keyId: "toggle-standard-keyboard", density: "compact", flexGrow: 1 },
        { keyId: "directional-flick", density: "compact" },
        { keyId: "profile-surface", density: "compact" },
      ],
    },
  ],
};

type StoredCustomKeyboardState = {
  profiles?: unknown;
  workspaceProfileIds?: unknown;
  activeProfileIdsByWorkspace?: unknown;
  globalActiveProfileId?: unknown;
};

export type CustomKeyboardState = {
  profiles: CustomKeyboardProfile[];
  workspaceProfileIds: Record<string, string[]>;
  activeProfileIdsByWorkspace: Record<string, string>;
  globalActiveProfileId: string;
};

const CUSTOM_KEYBOARD_PROFILE_NAME_MAX_LENGTH = 40;

export function useCustomKeyboardViewModel(options: CustomKeyboardControllerOptions): CustomKeyboardController {
  const [state, setState] = useState<CustomKeyboardState>(() => createDefaultCustomKeyboardState());
  const [storage] = useState<CustomKeyboardStorage>(() => createCustomKeyboardStorage());
  const [isHydrated, setIsHydrated] = useState(false);
  const [localActiveModifiers, setLocalActiveModifiers] = useState<CustomKeyboardModifier[]>([]);
  const activeModifiers = options.activeModifiers ?? localActiveModifiers;
  const activeModifiersRef = useRef<CustomKeyboardModifier[]>([...activeModifiers]);

  const activeProfileId = useMemo(
    () => resolveActiveProfileId(state, options.workspaceId),
    [options.workspaceId, state],
  );
  const activeProfile = useMemo(
    () => state.profiles.find((profile) => profile.id === activeProfileId) ?? createDefaultCustomKeyboardProfile(),
    [activeProfileId, state.profiles],
  );
  const linkedProfileIds = useMemo(
    () => (options.workspaceId ? (state.workspaceProfileIds[options.workspaceId] ?? []) : []),
    [options.workspaceId, state.workspaceProfileIds],
  );
  const profileSummaries = useMemo(
    () =>
      state.profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        icon: profile.icon,
        linked: options.workspaceId
          ? profile.id === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID || linkedProfileIds.includes(profile.id)
          : true,
      })),
    [linkedProfileIds, options.workspaceId, state.profiles],
  );
  const activeProfileSummary = useMemo(
    () =>
      profileSummaries.find((profile) => profile.id === activeProfileId) ?? {
        id: DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID,
        name: "Default",
        icon: "terminal" as const,
        linked: true,
      },
    [activeProfileId, profileSummaries],
  );

  useLayoutEffect(() => {
    activeModifiersRef.current = [...activeModifiers];
  }, [activeModifiers]);

  const updateActiveModifiers = useCallback(
    (nextModifiers: readonly CustomKeyboardModifier[]) => {
      const next = [...nextModifiers];
      activeModifiersRef.current = next;
      setLocalActiveModifiers(next);
      options.onActiveModifiersChange?.(next);
    },
    [options.onActiveModifiersChange],
  );

  useEffect(() => {
    let disposed = false;
    void storage
      .read()
      .then((raw) => {
        if (disposed) return;
        setState(parseCustomKeyboardState(raw));
        setIsHydrated(true);
      })
      .catch(() => {
        if (!disposed) setIsHydrated(true);
      });
    return () => {
      disposed = true;
    };
  }, [storage]);

  useEffect(() => {
    if (!isHydrated) return;
    void storage.write(JSON.stringify(state));
  }, [isHydrated, state, storage]);

  const onSelectProfile = useCallback(
    (profileId: string) => {
      setState((current) => selectCustomKeyboardProfile(current, options.workspaceId, profileId));
      updateActiveModifiers([]);
    },
    [options.workspaceId, updateActiveModifiers],
  );

  const onCreateProfile = useCallback(
    (input: { name: string; icon: CustomKeyboardIcon }) => {
      setState((current) => createCustomKeyboardProfile(current, options.workspaceId, input));
      updateActiveModifiers([]);
    },
    [options.workspaceId, updateActiveModifiers],
  );

  const onDuplicateProfile = useCallback(
    (profileId: string) => {
      setState((current) => duplicateCustomKeyboardProfile(current, options.workspaceId, profileId));
      updateActiveModifiers([]);
    },
    [options.workspaceId, updateActiveModifiers],
  );

  const onRenameProfile = useCallback((profileId: string, name: string) => {
    if (!isCustomKeyboardProfileNameValid(name)) return;
    setState((current) =>
      updateCustomKeyboardProfile(current, profileId, (profile) => ({ ...profile, name: name.trim() })),
    );
  }, []);

  const onDeleteProfile = useCallback(
    (profileId: string) => {
      setState((current) => deleteCustomKeyboardProfile(current, profileId));
      updateActiveModifiers([]);
    },
    [updateActiveModifiers],
  );

  const onSetProfileIcon = useCallback((profileId: string, icon: CustomKeyboardIcon) => {
    setState((current) => updateCustomKeyboardProfile(current, profileId, (profile) => ({ ...profile, icon })));
  }, []);

  const onToggleProfileLink = useCallback(
    (profileId: string) => {
      setState((current) => toggleCustomKeyboardProfileLink(current, options.workspaceId, profileId));
      updateActiveModifiers([]);
    },
    [options.workspaceId, updateActiveModifiers],
  );

  const onToggleNativeKeyboard = useCallback(() => {
    options.onNativeKeyboardToggle();
  }, [options.onNativeKeyboardToggle]);

  const onActivateKey = useCallback(
    (key: CustomKeyboardKey) => {
      const activation = key.activation;
      if (activation.type === "surface" || activation.type === "directional-flick") return;
      const modifier = activation.type === "modifier" ? activation.modifier : null;
      if (modifier) {
        updateActiveModifiers(toggleCustomKeyboardModifier(activeModifiersRef.current, modifier));
        return;
      }
      const modifiers = activeModifiersRef.current;
      updateActiveModifiers([]);
      if (activation.type === "sequence") {
        options.onSequence(activation.sequence, modifiers);
      } else if (activation.type === "native") {
        if (activation.action === "toggle-standard-keyboard") onToggleNativeKeyboard();
        options.onNativeAction?.(activation.action);
      } else if (activation.type === "terminal") {
        options.onTerminalAction(activation.action);
      }
    },
    [
      onToggleNativeKeyboard,
      options.onNativeAction,
      options.onSequence,
      options.onTerminalAction,
      updateActiveModifiers,
    ],
  );

  const onDirectionalFlick = useCallback(
    (direction: CustomKeyboardFlickDirection) => {
      updateActiveModifiers([]);
      options.onSequence([{ type: "key", key: directionalFlickKey(direction) }], []);
      options.onKeyEffect?.();
    },
    [options.onKeyEffect, options.onSequence, updateActiveModifiers],
  );

  const onKeepNativeKeyboardOpen = useCallback(() => {
    options.onKeepNativeKeyboardOpen?.();
  }, [options.onKeepNativeKeyboardOpen]);

  const onDrop = useCallback(
    (source: CustomKeyboardDragSource, target: CustomKeyboardDropTarget) => {
      setState((current) => {
        const currentProfile = current.profiles.find(
          (profile) => profile.id === resolveActiveProfileId(current, options.workspaceId),
        );
        if (!currentProfile) return current;
        const sourceKey = currentProfile.libraryKeys.find((key) => key.id === source.keyId);
        if (!sourceKey) return current;
        if (source.collection === "shortcut-library" && sourceKey.category !== "shortcuts") return current;
        return updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => {
          const next = applyCustomKeyboardDrop(
            { layout: profile.layout, shortcutKeyIds: profile.shortcutKeyIds },
            source,
            target,
          );
          return {
            ...profile,
            layout: next.layout,
            shortcutKeyIds: [...next.shortcutKeyIds],
          };
        });
      });
    },
    [options.workspaceId],
  );

  const onRemoveKey = useCallback(
    (keyId: string) => {
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => ({
          ...profile,
          layout: removeKeyFromLayout(profile.layout, keyId),
        })),
      );
    },
    [options.workspaceId],
  );

  const onRegisterShortcut = useCallback(
    (draft: CustomKeyboardShortcutDraft) => {
      if (!isCustomKeyboardShortcutDraftValid(draft)) return;
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => {
          const id = nextShortcutId(profile.libraryKeys);
          const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
          const shortcut: CustomKeyboardKey = {
            id,
            category: "shortcuts",
            icon: draft.icon,
            accessibleLabel: `${iconLabel} shortcut`,
            activation: { type: "sequence", sequence: draft.sequence },
          };
          return {
            ...profile,
            libraryKeys: [...profile.libraryKeys, shortcut],
            shortcutKeyIds: [...profile.shortcutKeyIds, shortcut.id],
          };
        }),
      );
    },
    [options.workspaceId],
  );

  const onUpdateShortcut = useCallback(
    (keyId: string, draft: CustomKeyboardShortcutDraft) => {
      if (!isCustomKeyboardShortcutDraftValid(draft)) return;
      const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
      const update = (key: CustomKeyboardKey): CustomKeyboardKey =>
        key.id === keyId
          ? {
              ...key,
              icon: draft.icon,
              accessibleLabel: `${iconLabel} shortcut`,
              activation: { type: "sequence", sequence: draft.sequence },
            }
          : key;
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => ({
          ...profile,
          libraryKeys: profile.libraryKeys.map(update),
        })),
      );
    },
    [options.workspaceId],
  );

  const onDeleteShortcut = useCallback(
    (keyId: string) => {
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => ({
          ...profile,
          layout: removeKeyFromLayout(profile.layout, keyId),
          libraryKeys: profile.libraryKeys.filter((key) => key.id !== keyId),
          shortcutKeyIds: profile.shortcutKeyIds.filter((id) => id !== keyId),
        })),
      );
    },
    [options.workspaceId],
  );

  const rows = useMemo(
    () => resolveCustomKeyboardLayout(activeProfile.layout, activeProfile.libraryKeys),
    [activeProfile],
  );
  const surfaces = useMemo(
    () =>
      customKeyboardSurfaceDefinitions.map((surface) => ({
        id: surface.id,
        keys: keysFromIds(surface.keyIds, activeProfile.libraryKeys),
      })),
    [activeProfile.libraryKeys],
  );
  const shortcutKeys = useMemo(
    () => keysFromIds(activeProfile.shortcutKeyIds, activeProfile.libraryKeys),
    [activeProfile],
  );
  const assignedIds = useMemo(() => assignedKeyIds(activeProfile.layout), [activeProfile.layout]);
  const availableKeys = useMemo(() => {
    const assigned = new Set(assignedIds);
    return activeProfile.libraryKeys.filter((candidate) => !assigned.has(candidate.id));
  }, [activeProfile.libraryKeys, assignedIds]);

  const keyboard: CustomKeyboardViewModel = {
    rows,
    surfaces,
    activeModifiers,
    nativeKeyboardVisible: options.nativeKeyboardVisible,
    activeProfile: activeProfileSummary,
    profiles: profileSummaries,
    workspaceId: options.workspaceId,
    repeatStartDelayMs: activeProfile.repeatStartDelayMs,
    repeatIntervalMs: activeProfile.repeatIntervalMs,
    onSelectProfile,
    onActivateKey,
    onDirectionalFlick,
    onNativeFileSelected: (action, file) => options.onNativeFileSelected?.(action, file),
    onKeepNativeKeyboardOpen,
    onToggleNativeKeyboard,
  };

  const settings: CustomKeyboardSettingsViewModel = {
    rows,
    availableKeys,
    shortcutKeys,
    activeProfile: activeProfileSummary,
    profiles: profileSummaries,
    linkedProfileIds,
    workspaceId: options.workspaceId,
    assignedKeyIds: assignedIds,
    repeatStartDelayMs: activeProfile.repeatStartDelayMs,
    repeatIntervalMs: activeProfile.repeatIntervalMs,
    onSelectProfile,
    onCreateProfile,
    onDuplicateProfile,
    onRenameProfile,
    onDeleteProfile,
    onSetProfileIcon,
    onToggleProfileLink,
    onDrop,
    onRemoveKey,
    onRegisterShortcut,
    onUpdateShortcut,
    onDeleteShortcut,
    onRepeatStartDelayChange: (repeatStartDelayMs) =>
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => ({
          ...profile,
          repeatStartDelayMs,
        })),
      ),
    onRepeatIntervalChange: (repeatIntervalMs) =>
      setState((current) =>
        updateActiveCustomKeyboardProfile(current, options.workspaceId, (profile) => ({
          ...profile,
          repeatIntervalMs,
        })),
      ),
  };

  return {
    keyboard,
    settings,
  };
}

function directionalFlickKey(direction: CustomKeyboardFlickDirection): string {
  return {
    up: "ArrowUp",
    down: "ArrowDown",
    left: "ArrowLeft",
    right: "ArrowRight",
  }[direction];
}

function keySequence(key: string): CustomKeyboardSequence {
  return [keyToken(key)];
}

function textSequence(value: string): CustomKeyboardSequence {
  return [textToken(value)];
}

function keyToken(key: string): CustomKeyboardSequenceToken {
  return { type: "key", key };
}

function textToken(value: string): CustomKeyboardSequenceToken {
  return { type: "text", value };
}

function uniqueKeys(keys: readonly CustomKeyboardKey[]): CustomKeyboardKey[] {
  return [...new Map(keys.map((key) => [key.id, key] as const)).values()];
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function nextShortcutId(keys: readonly CustomKeyboardKey[]): string {
  const existingIds = new Set(keys.map((key) => key.id));
  let index = keys.length + 1;
  while (existingIds.has(`custom-shortcut-${index}`)) index += 1;
  return `custom-shortcut-${index}`;
}

function nextProfileId(profiles: readonly CustomKeyboardProfile[]): string {
  const existingIds = new Set(profiles.map((profile) => profile.id));
  let index = profiles.length + 1;
  while (existingIds.has(`custom-keyboard-profile-${index}`)) index += 1;
  return `custom-keyboard-profile-${index}`;
}

export function isCustomKeyboardProfileNameValid(name: string): boolean {
  const trimmed = name.trim();
  return (
    trimmed.length > 0 && trimmed.length <= CUSTOM_KEYBOARD_PROFILE_NAME_MAX_LENGTH && !/[\u0000\r\n\t]/.test(name)
  );
}

function createDefaultCustomKeyboardState(): CustomKeyboardState {
  return {
    profiles: [createDefaultCustomKeyboardProfile()],
    workspaceProfileIds: {},
    activeProfileIdsByWorkspace: {},
    globalActiveProfileId: DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID,
  };
}

function createDefaultCustomKeyboardProfile(): CustomKeyboardProfile {
  return {
    id: DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID,
    name: "Default",
    icon: "terminal",
    layout: cloneCustomKeyboardLayout(defaultCustomKeyboardLayout),
    libraryKeys: [...customKeyboardKeyLibrary],
    shortcutKeyIds: customKeyboardKeyLibrary.filter((key) => key.category === "shortcuts").map((key) => key.id),
    repeatStartDelayMs: 420,
    repeatIntervalMs: 180,
  };
}

export function parseCustomKeyboardState(raw: string | null): CustomKeyboardState {
  const fallback = createDefaultCustomKeyboardState();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return fallback;
    return parseStoredCustomKeyboardState(parsed, fallback);
  } catch {
    return fallback;
  }
}

function parseStoredCustomKeyboardState(
  parsed: StoredCustomKeyboardState,
  fallback: CustomKeyboardState,
): CustomKeyboardState {
  if (
    !Array.isArray(parsed.profiles) ||
    !isRecord(parsed.workspaceProfileIds) ||
    !isRecord(parsed.activeProfileIdsByWorkspace) ||
    typeof parsed.globalActiveProfileId !== "string"
  ) {
    return fallback;
  }
  const profiles = normalizeProfiles(parsed.profiles);
  if (profiles.length === 0) return fallback;
  const profileIds = new Set(profiles.map((profile) => profile.id));
  const workspaceProfileIds = normalizeWorkspaceProfileIds(parsed.workspaceProfileIds, profileIds);
  const activeProfileIdsByWorkspace = normalizeActiveProfileIdsByWorkspace(
    parsed.activeProfileIdsByWorkspace,
    profileIds,
  );
  const globalActiveProfileId =
    typeof parsed.globalActiveProfileId === "string" && profileIds.has(parsed.globalActiveProfileId)
      ? parsed.globalActiveProfileId
      : DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID;
  return { profiles, workspaceProfileIds, activeProfileIdsByWorkspace, globalActiveProfileId };
}

function normalizeProfiles(value: unknown): CustomKeyboardProfile[] {
  if (!Array.isArray(value)) return [createDefaultCustomKeyboardProfile()];
  const parsedProfiles = value.flatMap((candidate) => {
    const profile = normalizeProfile(candidate);
    return profile ? [profile] : [];
  });
  const uniqueProfileMap = new Map<string, CustomKeyboardProfile>();
  for (const profile of parsedProfiles) {
    if (!uniqueProfileMap.has(profile.id)) uniqueProfileMap.set(profile.id, profile);
  }
  const defaultProfile =
    uniqueProfileMap.get(DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID) ?? createDefaultCustomKeyboardProfile();
  return [defaultProfile, ...[...uniqueProfileMap.values()].filter((profile) => profile.id !== defaultProfile.id)];
}

function normalizeProfile(value: unknown): CustomKeyboardProfile | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.trim().length === 0 ||
    typeof value.name !== "string" ||
    !isCustomKeyboardIcon(value.icon) ||
    !Array.isArray(value.libraryKeys) ||
    !isRecord(value.layout) ||
    !Array.isArray(value.shortcutKeyIds) ||
    typeof value.repeatStartDelayMs !== "number" ||
    typeof value.repeatIntervalMs !== "number"
  ) {
    return null;
  }
  const isDefault = value.id === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID;
  const name = isDefault ? "Default" : value.name.trim();
  if (!isDefault && !isCustomKeyboardProfileNameValid(name)) return null;
  const icon = isDefault ? "terminal" : (validProfileIcon(value.icon) ?? "terminal");
  const storedLibraryKeys = validKeyArray(value.libraryKeys) ?? [];
  const builtInKeyIds = new Set(customKeyboardKeyLibrary.map((key) => key.id));
  const libraryKeys = uniqueKeys([
    ...customKeyboardKeyLibrary,
    ...storedLibraryKeys.filter((key) => !builtInKeyIds.has(key.id)),
  ]);
  const layout = normalizeLayout(value.layout, libraryKeys);
  const defaultShortcutKeyIds = libraryKeys.filter((key) => key.category === "shortcuts").map((key) => key.id);
  const shortcutKeyIds = uniqueIds(
    (validStringArray(value.shortcutKeyIds) ?? defaultShortcutKeyIds).filter((keyId) =>
      libraryKeys.some((key) => key.id === keyId && key.category === "shortcuts"),
    ),
  );
  return {
    id: value.id,
    name: isDefault ? "Default" : name,
    icon,
    layout,
    libraryKeys,
    shortcutKeyIds,
    repeatStartDelayMs: validNumber(value.repeatStartDelayMs, 200, 1200, 420),
    repeatIntervalMs: validNumber(value.repeatIntervalMs, 80, 600, 180),
  };
}

function normalizeLayout(value: unknown, libraryKeys: readonly CustomKeyboardKey[]): CustomKeyboardLayout {
  if (!isRecord(value) || !Array.isArray(value.rows)) return cloneCustomKeyboardLayout(defaultCustomKeyboardLayout);
  const libraryKeyIds = new Set(libraryKeys.map((key) => key.id));
  const usedKeyIds = new Set<string>();
  const usedRowIds = new Set<string>();
  const rows: CustomKeyboardLayoutRow[] = value.rows.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.trim().length === 0) return [];
    if (usedRowIds.has(candidate.id) || !Array.isArray(candidate.placements)) return [];
    const overflow = candidate.overflow === "stable" || candidate.overflow === "scroll" ? candidate.overflow : null;
    if (!overflow) return [];
    usedRowIds.add(candidate.id);
    const placements: CustomKeyboardLayoutPlacement[] = candidate.placements.flatMap((placement) => {
      if (!isRecord(placement) || typeof placement.keyId !== "string" || !libraryKeyIds.has(placement.keyId)) {
        return [];
      }
      if (usedKeyIds.has(placement.keyId)) return [];
      const density = placement.density === "compact" || placement.density === "regular" ? placement.density : null;
      if (!density) return [];
      const flexGrow = validFlexGrow(placement.flexGrow);
      usedKeyIds.add(placement.keyId);
      return [
        {
          keyId: placement.keyId,
          density: density as "compact" | "regular",
          ...(flexGrow === undefined ? {} : { flexGrow }),
        },
      ];
    });
    return [{ id: candidate.id, overflow: overflow as "scroll" | "stable", placements }];
  });
  return rows.length > 0 ? { rows } : cloneCustomKeyboardLayout(defaultCustomKeyboardLayout);
}

function cloneCustomKeyboardLayout(layout: CustomKeyboardLayout): CustomKeyboardLayout {
  return {
    rows: layout.rows.map((row) => ({
      ...row,
      placements: row.placements.map((placement) => ({ ...placement })),
    })),
  };
}

function cloneCustomKeyboardKey(key: CustomKeyboardKey): CustomKeyboardKey {
  const activation = key.activation;
  return {
    ...key,
    activation:
      activation.type === "sequence"
        ? { type: "sequence", sequence: activation.sequence.map((token) => ({ ...token })) }
        : { ...activation },
  };
}

function validFlexGrow(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 8 ? value : undefined;
}

function normalizeWorkspaceProfileIds(value: unknown, profileIds: ReadonlySet<string>): Record<string, string[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([workspaceId, profileIdsValue]) => {
      if (!workspaceId || !Array.isArray(profileIdsValue)) return [];
      const ids = uniqueIds(
        profileIdsValue.filter(
          (profileId): profileId is string =>
            typeof profileId === "string" &&
            profileId !== DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID &&
            profileIds.has(profileId),
        ),
      );
      return ids.length > 0 ? [[workspaceId, ids]] : [];
    }),
  );
}

function normalizeActiveProfileIdsByWorkspace(value: unknown, profileIds: ReadonlySet<string>): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([workspaceId, profileId]) =>
      workspaceId && typeof profileId === "string" && profileIds.has(profileId) ? [[workspaceId, profileId]] : [],
    ),
  );
}

export function resolveActiveProfileId(state: CustomKeyboardState, workspaceId: string | null): string {
  const profileIds = new Set(state.profiles.map((profile) => profile.id));
  if (!workspaceId)
    return profileIds.has(state.globalActiveProfileId)
      ? state.globalActiveProfileId
      : DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID;
  const linkedProfileIds = state.workspaceProfileIds[workspaceId] ?? [];
  const mappedProfileId = state.activeProfileIdsByWorkspace[workspaceId];
  if (
    mappedProfileId &&
    profileIds.has(mappedProfileId) &&
    (mappedProfileId === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID || linkedProfileIds.includes(mappedProfileId))
  ) {
    return mappedProfileId;
  }
  return linkedProfileIds.find((profileId) => profileIds.has(profileId)) ?? DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID;
}

function updateActiveCustomKeyboardProfile(
  state: CustomKeyboardState,
  workspaceId: string | null,
  update: (profile: CustomKeyboardProfile) => CustomKeyboardProfile,
): CustomKeyboardState {
  const activeProfileId = resolveActiveProfileId(state, workspaceId);
  return {
    ...state,
    profiles: state.profiles.map((profile) => (profile.id === activeProfileId ? update(profile) : profile)),
  };
}

function updateCustomKeyboardProfile(
  state: CustomKeyboardState,
  profileId: string,
  update: (profile: CustomKeyboardProfile) => CustomKeyboardProfile,
): CustomKeyboardState {
  if (!state.profiles.some((profile) => profile.id === profileId)) return state;
  return {
    ...state,
    profiles: state.profiles.map((profile) => (profile.id === profileId ? update(profile) : profile)),
  };
}

export function selectCustomKeyboardProfile(
  state: CustomKeyboardState,
  workspaceId: string | null,
  profileId: string,
): CustomKeyboardState {
  if (!state.profiles.some((profile) => profile.id === profileId)) return state;
  if (!workspaceId) return { ...state, globalActiveProfileId: profileId };
  const linkedProfileIds = state.workspaceProfileIds[workspaceId] ?? [];
  const nextLinkedProfileIds =
    profileId === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID ? linkedProfileIds : uniqueIds([...linkedProfileIds, profileId]);
  return {
    ...state,
    workspaceProfileIds: { ...state.workspaceProfileIds, [workspaceId]: nextLinkedProfileIds },
    activeProfileIdsByWorkspace: { ...state.activeProfileIdsByWorkspace, [workspaceId]: profileId },
  };
}

export function createCustomKeyboardProfile(
  state: CustomKeyboardState,
  workspaceId: string | null,
  input: { name: string; icon: CustomKeyboardIcon },
): CustomKeyboardState {
  if (!isCustomKeyboardProfileNameValid(input.name)) return state;
  const profile: CustomKeyboardProfile = {
    ...createDefaultCustomKeyboardProfile(),
    id: nextProfileId(state.profiles),
    name: input.name.trim(),
    icon: input.icon,
  };
  return selectCustomKeyboardProfile({ ...state, profiles: [...state.profiles, profile] }, workspaceId, profile.id);
}

export function duplicateCustomKeyboardProfile(
  state: CustomKeyboardState,
  workspaceId: string | null,
  profileId: string,
): CustomKeyboardState {
  const source = state.profiles.find((profile) => profile.id === profileId);
  if (!source) return state;
  const profile: CustomKeyboardProfile = {
    ...source,
    id: nextProfileId(state.profiles),
    name: nextDuplicateProfileName(source.name, state.profiles),
    libraryKeys: source.libraryKeys.map((key) => cloneCustomKeyboardKey(key)),
    layout: cloneCustomKeyboardLayout(source.layout),
    shortcutKeyIds: [...source.shortcutKeyIds],
  };
  return selectCustomKeyboardProfile({ ...state, profiles: [...state.profiles, profile] }, workspaceId, profile.id);
}

function nextDuplicateProfileName(sourceName: string, profiles: readonly CustomKeyboardProfile[]): string {
  const existingNames = new Set(profiles.map((profile) => profile.name.toLowerCase()));
  const baseName = `${sourceName} Copy`.slice(0, CUSTOM_KEYBOARD_PROFILE_NAME_MAX_LENGTH).trim();
  if (!existingNames.has(baseName.toLowerCase())) return baseName;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${baseName.slice(0, CUSTOM_KEYBOARD_PROFILE_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!existingNames.has(candidate.toLowerCase())) return candidate;
  }
  return `Profile ${profiles.length + 1}`.slice(0, CUSTOM_KEYBOARD_PROFILE_NAME_MAX_LENGTH);
}

export function deleteCustomKeyboardProfile(state: CustomKeyboardState, profileId: string): CustomKeyboardState {
  if (profileId === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID || !state.profiles.some((profile) => profile.id === profileId)) {
    return state;
  }
  const profiles = state.profiles.filter((profile) => profile.id !== profileId);
  const workspaceProfileIds = Object.fromEntries(
    Object.entries(state.workspaceProfileIds).flatMap(([id, linkedProfileIds]) => {
      const nextIds = linkedProfileIds.filter((linkedProfileId) => linkedProfileId !== profileId);
      return nextIds.length > 0 ? [[id, nextIds]] : [];
    }),
  );
  const activeProfileIdsByWorkspace = Object.fromEntries(
    Object.entries(state.activeProfileIdsByWorkspace).flatMap(([id, activeId]) =>
      activeId === profileId ? [[id, DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID]] : [[id, activeId]],
    ),
  );
  return {
    profiles,
    workspaceProfileIds,
    activeProfileIdsByWorkspace,
    globalActiveProfileId:
      state.globalActiveProfileId === profileId ? DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID : state.globalActiveProfileId,
  };
}

export function toggleCustomKeyboardProfileLink(
  state: CustomKeyboardState,
  workspaceId: string | null,
  profileId: string,
): CustomKeyboardState {
  if (
    !workspaceId ||
    profileId === DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID ||
    !state.profiles.some((profile) => profile.id === profileId)
  ) {
    return state;
  }
  const linkedProfileIds = state.workspaceProfileIds[workspaceId] ?? [];
  if (linkedProfileIds.includes(profileId)) {
    const nextLinkedProfileIds = linkedProfileIds.filter((linkedProfileId) => linkedProfileId !== profileId);
    const activeProfileIdsByWorkspace =
      state.activeProfileIdsByWorkspace[workspaceId] === profileId
        ? {
            ...state.activeProfileIdsByWorkspace,
            [workspaceId]: nextLinkedProfileIds[0] ?? DEFAULT_CUSTOM_KEYBOARD_PROFILE_ID,
          }
        : state.activeProfileIdsByWorkspace;
    const workspaceProfileIds = { ...state.workspaceProfileIds };
    if (nextLinkedProfileIds.length > 0) workspaceProfileIds[workspaceId] = nextLinkedProfileIds;
    else delete workspaceProfileIds[workspaceId];
    return { ...state, workspaceProfileIds, activeProfileIdsByWorkspace };
  }
  return {
    ...state,
    workspaceProfileIds: { ...state.workspaceProfileIds, [workspaceId]: [...linkedProfileIds, profileId] },
  };
}

function validProfileIcon(value: unknown): CustomKeyboardIcon | null {
  return isCustomKeyboardIcon(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function validStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((candidate): candidate is string => typeof candidate === "string");
}

function validKeyArray(value: unknown): CustomKeyboardKey[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((key): key is CustomKeyboardKey => {
    if (!isRecord(key)) return false;
    if (
      typeof key.id !== "string" ||
      (key.category !== "abc" &&
        key.category !== "123" &&
        key.category !== "special" &&
        key.category !== "shortcuts") ||
      typeof key.accessibleLabel !== "string" ||
      (key.icon !== undefined && !isCustomKeyboardIcon(key.icon)) ||
      (key.label !== undefined && typeof key.label !== "string") ||
      !isRecord(key.activation)
    ) {
      return false;
    }
    return validKeyActivation(key.activation);
  });
}

function validKeyActivation(value: Record<string, unknown>): value is CustomKeyboardKey["activation"] {
  switch (value.type) {
    case "sequence":
      return validSequence(value.sequence) !== null;
    case "modifier":
      return isCustomKeyboardModifier(value.modifier);
    case "native":
      return isCustomKeyboardNativeAction(value.action);
    case "terminal":
      return isCustomKeyboardTerminalAction(value.action);
    case "directional-flick":
      return Object.keys(value).length === 1;
    case "surface":
      return value.surface === "clipboard" || value.surface === "profile";
    default:
      return false;
  }
}

function validSequence(value: unknown): CustomKeyboardSequence | null {
  if (!Array.isArray(value) || !value.every(validSequenceToken)) return null;
  return value;
}

function validSequenceToken(value: unknown): value is CustomKeyboardSequenceToken {
  if (!value || typeof value !== "object") return false;
  const token = value as Partial<CustomKeyboardSequenceToken>;
  if (token.type === "text") return typeof token.value === "string";
  if (token.type !== "key" || typeof token.key !== "string" || token.key.length === 0) return false;
  return (
    token.modifiers === undefined || (Array.isArray(token.modifiers) && token.modifiers.every(isCustomKeyboardModifier))
  );
}

function isCustomKeyboardModifier(value: unknown): value is CustomKeyboardModifier {
  return value === "ctrl" || value === "alt" || value === "shift";
}

function isCustomKeyboardIcon(value: unknown): value is CustomKeyboardIcon {
  return customKeyboardIconOptions.some((option) => option.value === value);
}

function isCustomKeyboardNativeAction(value: unknown): value is CustomKeyboardNativeAction {
  return (
    value === "pick-photo" || value === "capture-photo" || value === "scan-qr" || value === "toggle-standard-keyboard"
  );
}

function validNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
