import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  applyCustomKeyboardDrop,
  isCustomKeyboardShortcutDraftValid,
  selectedButtonsFromIds,
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

export type CustomKeyboardButtonCategory = "abc" | "123" | "special" | "shortcuts";

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

export type CustomKeyboardButton = {
  id: string;
  kind: "key" | "modifier" | "shortcut";
  category: CustomKeyboardButtonCategory;
  icon?: CustomKeyboardIcon;
  label?: string;
  accessibleLabel: string;
  sequence: CustomKeyboardSequence;
  modifier?: CustomKeyboardModifier;
  interaction?: "directional-flick";
  nativeAction?: CustomKeyboardNativeAction;
  terminalAction?: CustomKeyboardTerminalAction;
};

export type CustomKeyboardDragCollection = "keyboard" | "library" | "shortcut-library";

export type CustomKeyboardDragSource = {
  buttonId: string;
  collection: CustomKeyboardDragCollection;
};

export type CustomKeyboardDropTarget =
  | {
      type: "keyboard";
      targetButtonId: string | null;
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
  buttons: readonly CustomKeyboardButton[];
  activeModifiers: readonly CustomKeyboardModifier[];
  nativeKeyboardVisible: boolean;
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
  onButtonPress: (button: CustomKeyboardButton) => void;
  onDirectionalFlick: (direction: CustomKeyboardFlickDirection) => void;
  onNativeAction: (action: CustomKeyboardNativeAction) => void;
  onTerminalAction: (action: CustomKeyboardTerminalAction) => void;
  onNativeFileSelected: (action: CustomKeyboardNativeFileAction, file: File) => void;
  onKeepNativeKeyboardOpen: () => void;
  onToggleNativeKeyboard: () => void;
};

export type CustomKeyboardSettingsViewModel = {
  buttons: readonly CustomKeyboardButton[];
  availableButtons: readonly CustomKeyboardButton[];
  shortcutButtons: readonly CustomKeyboardButton[];
  selectedButtonIds: readonly string[];
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
  onDrop: (source: CustomKeyboardDragSource, target: CustomKeyboardDropTarget) => void;
  onRemoveButton: (buttonId: string) => void;
  onRegisterShortcut: (draft: CustomKeyboardShortcutDraft) => void;
  onUpdateShortcut: (buttonId: string, draft: CustomKeyboardShortcutDraft) => void;
  onDeleteShortcut: (buttonId: string) => void;
  onRepeatStartDelayChange: (startDelayMs: number) => void;
  onRepeatIntervalChange: (intervalMs: number) => void;
};

export type CustomKeyboardControllerOptions = {
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
  { value: "directional-flick", glyph: "◎", label: "Directional arrows", category: "terminal" },
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
  { value: "globe", glyph: "◎", label: "Globe", category: "device" },
  { value: "flashlight", glyph: "☼", label: "Flashlight", category: "device" },
  { value: "phone", glyph: "☎", label: "Phone", category: "device" },
  { value: "qr", glyph: "▦", label: "QR scanner", category: "device" },
  { value: "volume-up", glyph: "))", label: "Volume up", category: "device" },
  { value: "volume-down", glyph: ")", label: "Volume down", category: "device" },
  { value: "lock", glyph: "⌑", label: "Lock", category: "device" },
];

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

function specialKeyButton(id: string): CustomKeyboardButton {
  const definition = customKeyboardSpecialKeyOptions.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown special key: ${id}`);
  return {
    id: definition.id,
    kind: "key",
    category: "special",
    icon: definition.icon,
    label: definition.label,
    accessibleLabel: definition.accessibleLabel,
    sequence: keySequence(definition.key),
  };
}

function specialModifierButton(id: string): CustomKeyboardButton {
  const definition = customKeyboardSpecialModifierOptions.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown special modifier: ${id}`);
  return {
    id: definition.id,
    kind: "modifier",
    category: "special",
    icon: definition.icon,
    label: definition.label,
    accessibleLabel: definition.accessibleLabel,
    sequence: [],
    modifier: definition.modifier,
  };
}

function terminalActionButton(id: string): CustomKeyboardButton {
  const definition = customKeyboardTerminalActionOptions.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Unknown terminal action: ${id}`);
  return {
    id: definition.id,
    kind: "key",
    category: "special",
    icon: definition.icon,
    label: definition.label,
    accessibleLabel: definition.accessibleLabel,
    sequence: [],
    terminalAction: definition.action,
  };
}

export const defaultCustomKeyboardButtons: readonly CustomKeyboardButton[] = [
  specialKeyButton("escape"),
  specialKeyButton("tab"),
  specialKeyButton("delete"),
  {
    id: "directional-flick",
    kind: "key",
    category: "special",
    icon: "directional-flick",
    label: "Arrows",
    accessibleLabel: "Directional arrow input",
    sequence: [],
    interaction: "directional-flick",
  },
  specialModifierButton("ctrl"),
  specialModifierButton("alt"),
  terminalActionButton("copy-mode"),
  terminalActionButton("paste-clipboard"),
  terminalActionButton("paste-tmux-buffer"),
  {
    id: "slash",
    kind: "key",
    category: "123",
    icon: "slash",
    accessibleLabel: "Slash",
    sequence: textSequence("/"),
  },
  {
    id: "double-quote",
    kind: "key",
    category: "123",
    icon: "quote",
    accessibleLabel: "Double quote",
    sequence: textSequence('"'),
  },
  {
    id: "apostrophe",
    kind: "key",
    category: "123",
    icon: "apostrophe",
    accessibleLabel: "Apostrophe",
    sequence: textSequence("'"),
  },
  {
    id: "pipe",
    kind: "key",
    category: "123",
    icon: "pipe",
    accessibleLabel: "Pipe",
    sequence: textSequence("|"),
  },
  {
    id: "tilde",
    kind: "key",
    category: "123",
    icon: "tilde",
    accessibleLabel: "Tilde",
    sequence: textSequence("~"),
  },
  {
    id: "at",
    kind: "key",
    category: "123",
    icon: "at",
    accessibleLabel: "At sign",
    sequence: textSequence("@"),
  },
  {
    id: "git-status",
    kind: "shortcut",
    category: "shortcuts",
    icon: "branch",
    accessibleLabel: "Git status shortcut",
    sequence: [textToken("git status"), keyToken("Enter")],
  },
];

const alphabetCustomKeyboardButtons: readonly CustomKeyboardButton[] = [..."qwertyuiopasdfghjklzxcvbnm"].map((key) => ({
  id: `letter-${key}`,
  kind: "key",
  category: "abc",
  icon: "letter",
  label: key,
  accessibleLabel: `Letter ${key.toUpperCase()}`,
  sequence: [keyToken(key)],
}));

const numberCustomKeyboardButtons: readonly CustomKeyboardButton[] = [
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
  kind: "key",
  category: "123",
  icon: "number",
  label: value,
  accessibleLabel: `Key ${value}`,
  sequence: [textToken(value)],
}));

const numberSymbolCustomKeyboardButtons: readonly CustomKeyboardButton[] = [
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
  kind: "key",
  category: "123",
  icon: "number",
  label: value,
  accessibleLabel,
  sequence: [textToken(value)],
}));

const nativeCustomKeyboardButtons: readonly CustomKeyboardButton[] = [
  {
    id: "camera",
    kind: "key",
    category: "special",
    icon: "camera",
    label: "CAM",
    accessibleLabel: "Open camera",
    sequence: [],
    nativeAction: "capture-photo",
  },
  {
    id: "photo-library",
    kind: "key",
    category: "special",
    icon: "photo",
    label: "PHOTO",
    accessibleLabel: "Open photo library",
    sequence: [],
    nativeAction: "pick-photo",
  },
];

const builtInShortcutButtons: readonly CustomKeyboardButton[] = [
  {
    id: "npm-test",
    kind: "shortcut",
    category: "shortcuts",
    icon: "bolt",
    accessibleLabel: "Run Bun test shortcut",
    sequence: [textToken("bun test"), keyToken("Enter")],
  },
  {
    id: "clear-screen",
    kind: "shortcut",
    category: "shortcuts",
    icon: "terminal",
    accessibleLabel: "Clear terminal shortcut",
    sequence: [textToken("clear"), keyToken("Enter")],
  },
];

const shiftCustomKeyboardButton = { ...specialModifierButton("shift"), category: "abc" as const };

export const customKeyboardButtonLibrary: readonly CustomKeyboardButton[] = uniqueButtons([
  ...defaultCustomKeyboardButtons,
  shiftCustomKeyboardButton,
  ...alphabetCustomKeyboardButtons,
  ...numberCustomKeyboardButtons,
  ...numberSymbolCustomKeyboardButtons,
  ...customKeyboardSpecialKeyOptions.map((definition) => specialKeyButton(definition.id)),
  ...customKeyboardSpecialModifierOptions
    .filter((definition) => definition.id !== "shift")
    .map((definition) => specialModifierButton(definition.id)),
  ...customKeyboardTerminalActionOptions.map((definition) => terminalActionButton(definition.id)),
  ...nativeCustomKeyboardButtons,
  ...builtInShortcutButtons,
]);

type PersistedCustomKeyboardState = {
  selectedButtonIds: string[];
  libraryButtons: CustomKeyboardButton[];
  shortcutButtonIds: string[];
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
};

type StoredCustomKeyboardState = Partial<PersistedCustomKeyboardState> & {
  buttons?: unknown;
  shortcutButtons?: unknown;
};

export type CustomKeyboardState = PersistedCustomKeyboardState;

export function useCustomKeyboardViewModel(options: CustomKeyboardControllerOptions): CustomKeyboardController {
  const [state, setState] = useState<CustomKeyboardState>(() => createDefaultCustomKeyboardState());
  const [storage] = useState<CustomKeyboardStorage>(() => createCustomKeyboardStorage());
  const [isHydrated, setIsHydrated] = useState(false);
  const [localActiveModifiers, setLocalActiveModifiers] = useState<CustomKeyboardModifier[]>([]);
  const activeModifiers = options.activeModifiers ?? localActiveModifiers;
  const activeModifiersRef = useRef<CustomKeyboardModifier[]>([...activeModifiers]);

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
    const persisted: PersistedCustomKeyboardState = {
      selectedButtonIds: state.selectedButtonIds,
      libraryButtons: state.libraryButtons,
      shortcutButtonIds: state.shortcutButtonIds,
      repeatStartDelayMs: state.repeatStartDelayMs,
      repeatIntervalMs: state.repeatIntervalMs,
    };
    void storage.write(JSON.stringify(persisted));
  }, [
    isHydrated,
    state.libraryButtons,
    state.repeatIntervalMs,
    state.repeatStartDelayMs,
    state.selectedButtonIds,
    state.shortcutButtonIds,
    storage,
  ]);

  const onButtonPress = useCallback(
    (button: CustomKeyboardButton) => {
      const modifier = button.modifier;
      if (modifier) {
        updateActiveModifiers(toggleCustomKeyboardModifier(activeModifiersRef.current, modifier));
        return;
      }
      const modifiers = activeModifiersRef.current;
      updateActiveModifiers([]);
      options.onSequence(button.sequence, modifiers);
    },
    [options.onSequence, updateActiveModifiers],
  );

  const onDirectionalFlick = useCallback(
    (direction: CustomKeyboardFlickDirection) => {
      updateActiveModifiers([]);
      options.onSequence([{ type: "key", key: directionalFlickKey(direction) }], []);
      options.onKeyEffect?.();
    },
    [options.onKeyEffect, options.onSequence, updateActiveModifiers],
  );

  const onToggleNativeKeyboard = useCallback(() => {
    options.onNativeKeyboardToggle();
  }, [options.onNativeKeyboardToggle]);

  const onKeepNativeKeyboardOpen = useCallback(() => {
    options.onKeepNativeKeyboardOpen?.();
  }, [options.onKeepNativeKeyboardOpen]);

  const onNativeAction = useCallback(
    (action: CustomKeyboardNativeAction) => {
      updateActiveModifiers([]);
      if (action === "toggle-standard-keyboard") onToggleNativeKeyboard();
      options.onNativeAction?.(action);
    },
    [onToggleNativeKeyboard, options.onNativeAction, updateActiveModifiers],
  );

  const onTerminalAction = useCallback(
    (action: CustomKeyboardTerminalAction) => {
      updateActiveModifiers([]);
      options.onTerminalAction(action);
    },
    [options.onTerminalAction, updateActiveModifiers],
  );

  const onDrop = useCallback((source: CustomKeyboardDragSource, target: CustomKeyboardDropTarget) => {
    setState((current) => {
      const sourceButton = current.libraryButtons.find((button) => button.id === source.buttonId);
      if (!sourceButton) return current;
      if (source.collection === "shortcut-library" && sourceButton.kind !== "shortcut") return current;
      const next = applyCustomKeyboardDrop(current, source, target);
      return {
        ...current,
        selectedButtonIds: [...next.selectedButtonIds],
        shortcutButtonIds: [...next.shortcutButtonIds],
      };
    });
  }, []);

  const onRemoveButton = useCallback((buttonId: string) => {
    setState((current) => ({
      ...current,
      selectedButtonIds: current.selectedButtonIds.filter((id) => id !== buttonId),
    }));
  }, []);

  const onRegisterShortcut = useCallback((draft: CustomKeyboardShortcutDraft) => {
    if (!isCustomKeyboardShortcutDraftValid(draft)) return;
    setState((current) => {
      const id = nextShortcutId(current.libraryButtons);
      const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
      const shortcut: CustomKeyboardButton = {
        id,
        kind: "shortcut",
        category: "shortcuts",
        accessibleLabel: `${iconLabel} shortcut`,
        ...draft,
      };
      return {
        ...current,
        libraryButtons: [...current.libraryButtons, shortcut],
        shortcutButtonIds: [...current.shortcutButtonIds, shortcut.id],
      };
    });
  }, []);

  const onUpdateShortcut = useCallback((buttonId: string, draft: CustomKeyboardShortcutDraft) => {
    if (!isCustomKeyboardShortcutDraftValid(draft)) return;
    const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
    const update = (button: CustomKeyboardButton): CustomKeyboardButton =>
      button.id === buttonId
        ? { ...button, icon: draft.icon, sequence: draft.sequence, accessibleLabel: `${iconLabel} shortcut` }
        : button;
    setState((current) => ({
      ...current,
      libraryButtons: current.libraryButtons.map(update),
    }));
  }, []);

  const onDeleteShortcut = useCallback((buttonId: string) => {
    setState((current) => ({
      ...current,
      selectedButtonIds: current.selectedButtonIds.filter((id) => id !== buttonId),
      libraryButtons: current.libraryButtons.filter((button) => button.id !== buttonId),
      shortcutButtonIds: current.shortcutButtonIds.filter((id) => id !== buttonId),
    }));
  }, []);

  const buttons = useMemo(
    () => selectedButtonsFromIds(state.selectedButtonIds, state.libraryButtons),
    [state.libraryButtons, state.selectedButtonIds],
  );
  const shortcutButtons = useMemo(
    () => selectedButtonsFromIds(state.shortcutButtonIds, state.libraryButtons),
    [state.libraryButtons, state.shortcutButtonIds],
  );
  const availableButtons = useMemo(() => {
    const selectedButtonIds = new Set(state.selectedButtonIds);
    return state.libraryButtons.filter((candidate) => !selectedButtonIds.has(candidate.id));
  }, [state.libraryButtons, state.selectedButtonIds]);

  const keyboard: CustomKeyboardViewModel = {
    buttons,
    activeModifiers,
    nativeKeyboardVisible: options.nativeKeyboardVisible,
    repeatStartDelayMs: state.repeatStartDelayMs,
    repeatIntervalMs: state.repeatIntervalMs,
    onButtonPress,
    onDirectionalFlick,
    onNativeAction,
    onTerminalAction,
    onNativeFileSelected: (action, file) => options.onNativeFileSelected?.(action, file),
    onKeepNativeKeyboardOpen,
    onToggleNativeKeyboard,
  };

  const settings: CustomKeyboardSettingsViewModel = {
    buttons,
    availableButtons,
    shortcutButtons,
    selectedButtonIds: state.selectedButtonIds,
    repeatStartDelayMs: state.repeatStartDelayMs,
    repeatIntervalMs: state.repeatIntervalMs,
    onDrop,
    onRemoveButton,
    onRegisterShortcut,
    onUpdateShortcut,
    onDeleteShortcut,
    onRepeatStartDelayChange: (repeatStartDelayMs) => setState((current) => ({ ...current, repeatStartDelayMs })),
    onRepeatIntervalChange: (repeatIntervalMs) => setState((current) => ({ ...current, repeatIntervalMs })),
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

function uniqueButtons(buttons: readonly CustomKeyboardButton[]): CustomKeyboardButton[] {
  return [...new Map(buttons.map((button) => [button.id, button] as const)).values()];
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function nextShortcutId(buttons: readonly CustomKeyboardButton[]): string {
  const existingIds = new Set(buttons.map((button) => button.id));
  let index = buttons.length + 1;
  while (existingIds.has(`custom-shortcut-${index}`)) index += 1;
  return `custom-shortcut-${index}`;
}

function createDefaultCustomKeyboardState(): CustomKeyboardState {
  return {
    libraryButtons: [...customKeyboardButtonLibrary],
    selectedButtonIds: defaultCustomKeyboardButtons.map((button) => button.id),
    shortcutButtonIds: customKeyboardButtonLibrary
      .filter((button) => button.kind === "shortcut")
      .map((button) => button.id),
    repeatStartDelayMs: 420,
    repeatIntervalMs: 180,
  };
}

export function parseCustomKeyboardState(raw: string | null): CustomKeyboardState {
  const fallback = createDefaultCustomKeyboardState();
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as StoredCustomKeyboardState;
    const legacyButtons = validButtonArray(parsed.buttons);
    const storedLibraryButtons = validButtonArray(parsed.libraryButtons);
    const builtInButtonIds = new Set(customKeyboardButtonLibrary.map((button) => button.id));
    const libraryButtons = uniqueButtons([
      ...customKeyboardButtonLibrary,
      ...(storedLibraryButtons ?? []).filter((button) => !builtInButtonIds.has(button.id)),
      ...(legacyButtons ?? []).filter((button) => !builtInButtonIds.has(button.id)),
    ]);
    const selectedButtonIds = uniqueIds(
      (
        validStringArray(parsed.selectedButtonIds) ??
        legacyButtons?.map((button) => button.id) ??
        fallback.selectedButtonIds
      ).filter((buttonId) => libraryButtons.some((button) => button.id === buttonId)),
    );
    const legacyShortcutButtons = validButtonArray(parsed.shortcutButtons)?.filter(
      (button) => button.kind === "shortcut",
    );
    const shortcutButtonIds = uniqueIds(
      (
        validStringArray(parsed.shortcutButtonIds) ??
        legacyShortcutButtons?.map((button) => button.id) ??
        fallback.shortcutButtonIds
      ).filter((buttonId) => libraryButtons.some((button) => button.id === buttonId && button.kind === "shortcut")),
    );
    return {
      libraryButtons,
      selectedButtonIds,
      shortcutButtonIds,
      repeatStartDelayMs: validNumber(parsed.repeatStartDelayMs, 200, 1200, 420),
      repeatIntervalMs: validNumber(parsed.repeatIntervalMs, 80, 600, 180),
    };
  } catch {
    return fallback;
  }
}

function validStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((candidate): candidate is string => typeof candidate === "string");
}

function validButtonArray(value: unknown): CustomKeyboardButton[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((button): button is CustomKeyboardButton => {
    if (!button || typeof button !== "object") return false;
    const candidate = button as Partial<CustomKeyboardButton>;
    const sequence = validSequence(candidate.sequence);
    return (
      typeof candidate.id === "string" &&
      (candidate.kind === "key" || candidate.kind === "modifier" || candidate.kind === "shortcut") &&
      (candidate.category === "abc" ||
        candidate.category === "123" ||
        candidate.category === "special" ||
        candidate.category === "shortcuts") &&
      typeof candidate.accessibleLabel === "string" &&
      (candidate.interaction === undefined || candidate.interaction === "directional-flick") &&
      (candidate.terminalAction === undefined || isCustomKeyboardTerminalAction(candidate.terminalAction)) &&
      sequence !== null
    );
  });
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

function validNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
