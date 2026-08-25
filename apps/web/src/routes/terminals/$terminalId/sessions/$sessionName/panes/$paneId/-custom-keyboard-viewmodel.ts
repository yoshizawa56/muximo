import { useCallback, useEffect, useMemo, useState } from "react";

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
  nativeAction?: CustomKeyboardNativeAction;
};

export type CustomKeyboardShortcutDraft = {
  icon: CustomKeyboardIcon;
  sequence: CustomKeyboardSequence;
};

export type CustomKeyboardFlickDirection = "up" | "down" | "left" | "right";

export type CustomKeyboardFlickPreview = {
  direction: CustomKeyboardFlickDirection;
  xPercent: number;
  yPercent: number;
  repeating: boolean;
  startDelayMs: number;
  intervalMs: number;
};

export type CustomKeyboardViewModel = {
  buttons: readonly CustomKeyboardButton[];
  activeModifiers: readonly CustomKeyboardModifier[];
  nativeKeyboardVisible: boolean;
  flickPreview: CustomKeyboardFlickPreview | null;
  onButtonPress: (button: CustomKeyboardButton) => void;
  onNativeAction: (action: CustomKeyboardNativeAction) => void;
  onNativeFileSelected: (action: CustomKeyboardNativeFileAction, file: File) => void;
  onToggleNativeKeyboard: () => void;
  onOpenSettings: () => void;
};

export type CustomKeyboardSettingsViewModel = {
  buttons: readonly CustomKeyboardButton[];
  availableButtons: readonly CustomKeyboardButton[];
  shortcutButtons: readonly CustomKeyboardButton[];
  selectedButtonId: string | null;
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
  onSelectButton: (buttonId: string) => void;
  onSwapButton: (buttonId: string, targetButtonId: string) => void;
  onMoveShortcut: (buttonId: string, targetIndex: number) => void;
  onAddButton: (button: CustomKeyboardButton) => void;
  onRemoveButton: (buttonId: string) => void;
  onRegisterShortcut: (draft: CustomKeyboardShortcutDraft) => void;
  onUpdateShortcut: (buttonId: string, draft: CustomKeyboardShortcutDraft) => void;
  onDeleteShortcut: (buttonId: string) => void;
  onRepeatStartDelayChange: (startDelayMs: number) => void;
  onRepeatIntervalChange: (intervalMs: number) => void;
  onClose: () => void;
  onSave: () => void;
};

export type CustomKeyboardControllerOptions = {
  flickPreview: CustomKeyboardFlickPreview | null;
  onSequence: (sequence: CustomKeyboardSequence, activeModifiers: readonly CustomKeyboardModifier[]) => void;
  onNativeAction?: (action: CustomKeyboardNativeAction) => void;
  onNativeFileSelected?: (action: CustomKeyboardNativeFileAction, file: File) => void;
  onNativeKeyboardToggle?: (visible: boolean) => void;
};

export type CustomKeyboardController = {
  keyboard: CustomKeyboardViewModel;
  settings: CustomKeyboardSettingsViewModel;
  settingsOpen: boolean;
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
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

export const defaultCustomKeyboardButtons: readonly CustomKeyboardButton[] = [
  specialKeyButton("escape"),
  specialKeyButton("tab"),
  specialModifierButton("ctrl"),
  specialModifierButton("alt"),
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
    accessibleLabel: "Run npm test shortcut",
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
  ...customKeyboardSpecialModifierOptions.map((definition) => specialModifierButton(definition.id)),
  ...nativeCustomKeyboardButtons,
  ...builtInShortcutButtons,
]);

export const CUSTOM_KEYBOARD_STORAGE_KEY = "muximo.custom-keyboard.v1";

type PersistedCustomKeyboardState = {
  buttons: CustomKeyboardButton[];
  libraryButtons: CustomKeyboardButton[];
  shortcutButtons: CustomKeyboardButton[];
  repeatStartDelayMs: number;
  repeatIntervalMs: number;
};

type CustomKeyboardState = PersistedCustomKeyboardState & {
  selectedButtonId: string | null;
  settingsOpen: boolean;
};

export function useCustomKeyboardViewModel(options: CustomKeyboardControllerOptions): CustomKeyboardController {
  const [state, setState] = useState<CustomKeyboardState>(() => readCustomKeyboardState());
  const [activeModifiers, setActiveModifiers] = useState<CustomKeyboardModifier[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const persisted: PersistedCustomKeyboardState = {
      buttons: state.buttons,
      libraryButtons: state.libraryButtons,
      shortcutButtons: state.shortcutButtons,
      repeatStartDelayMs: state.repeatStartDelayMs,
      repeatIntervalMs: state.repeatIntervalMs,
    };
    try {
      window.localStorage.setItem(CUSTOM_KEYBOARD_STORAGE_KEY, JSON.stringify(persisted));
    } catch {
      // Storage may be unavailable in private browsing or an embedded webview.
    }
  }, [state.buttons, state.libraryButtons, state.repeatIntervalMs, state.repeatStartDelayMs, state.shortcutButtons]);

  const onButtonPress = useCallback(
    (button: CustomKeyboardButton) => {
      const modifier = button.modifier;
      if (modifier) {
        setActiveModifiers((current) =>
          current.includes(modifier)
            ? current.filter((currentModifier) => currentModifier !== modifier)
            : [...current, modifier],
        );
        return;
      }
      const modifiers = activeModifiers;
      setActiveModifiers([]);
      options.onSequence(button.sequence, modifiers);
    },
    [activeModifiers, options],
  );

  const [nativeKeyboardVisible, setNativeKeyboardVisible] = useState(false);
  const onToggleNativeKeyboard = useCallback(() => {
    const nextVisible = !nativeKeyboardVisible;
    setNativeKeyboardVisible(nextVisible);
    options.onNativeKeyboardToggle?.(nextVisible);
  }, [nativeKeyboardVisible, options]);

  const onNativeAction = useCallback(
    (action: CustomKeyboardNativeAction) => {
      setActiveModifiers([]);
      if (action === "toggle-standard-keyboard") onToggleNativeKeyboard();
      options.onNativeAction?.(action);
    },
    [onToggleNativeKeyboard, options],
  );

  const updateButtons = useCallback((update: (buttons: CustomKeyboardButton[]) => CustomKeyboardButton[]) => {
    setState((current) => ({ ...current, buttons: update(current.buttons) }));
  }, []);

  const onAddButton = useCallback((button: CustomKeyboardButton) => {
    setState((current) => ({
      ...current,
      buttons: current.buttons.some((candidate) => candidate.id === button.id)
        ? current.buttons
        : [...current.buttons, button],
      libraryButtons: current.libraryButtons.some((candidate) => candidate.id === button.id)
        ? current.libraryButtons
        : [...current.libraryButtons, button],
      selectedButtonId: button.id,
    }));
  }, []);

  const onSwapButton = useCallback(
    (buttonId: string, targetButtonId: string) => {
      updateButtons((current) => {
        const sourceIndex = current.findIndex((button) => button.id === buttonId);
        const targetIndex = current.findIndex((button) => button.id === targetButtonId);
        if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return current;
        const next = [...current];
        [next[sourceIndex], next[targetIndex]] = [next[targetIndex], next[sourceIndex]];
        return next;
      });
    },
    [updateButtons],
  );

  const onMoveShortcut = useCallback((buttonId: string, targetIndex: number) => {
    setState((current) => {
      const next = [...current.shortcutButtons];
      const sourceIndex = next.findIndex((button) => button.id === buttonId);
      if (sourceIndex < 0) return current;
      const [sourceButton] = next.splice(sourceIndex, 1);
      if (!sourceButton) return current;
      const insertionIndex = Math.max(
        0,
        Math.min(next.length, targetIndex > sourceIndex ? targetIndex - 1 : targetIndex),
      );
      next.splice(insertionIndex, 0, sourceButton);
      return { ...current, shortcutButtons: next };
    });
  }, []);

  const onRemoveButton = useCallback((buttonId: string) => {
    setState((current) => ({
      ...current,
      buttons: current.buttons.filter((button) => button.id !== buttonId),
      selectedButtonId: current.selectedButtonId === buttonId ? null : current.selectedButtonId,
    }));
  }, []);

  const onRegisterShortcut = useCallback((draft: CustomKeyboardShortcutDraft) => {
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
        shortcutButtons: [...current.shortcutButtons, shortcut],
        selectedButtonId: shortcut.id,
      };
    });
  }, []);

  const onUpdateShortcut = useCallback((buttonId: string, draft: CustomKeyboardShortcutDraft) => {
    const iconLabel = customKeyboardIconOptions.find((option) => option.value === draft.icon)?.label ?? "Custom";
    const update = (button: CustomKeyboardButton): CustomKeyboardButton =>
      button.id === buttonId
        ? { ...button, icon: draft.icon, sequence: draft.sequence, accessibleLabel: `${iconLabel} shortcut` }
        : button;
    setState((current) => ({
      ...current,
      buttons: current.buttons.map(update),
      libraryButtons: current.libraryButtons.map(update),
      shortcutButtons: current.shortcutButtons.map(update),
    }));
  }, []);

  const onDeleteShortcut = useCallback((buttonId: string) => {
    setState((current) => ({
      ...current,
      buttons: current.buttons.filter((button) => button.id !== buttonId),
      libraryButtons: current.libraryButtons.filter((button) => button.id !== buttonId),
      shortcutButtons: current.shortcutButtons.filter((button) => button.id !== buttonId),
      selectedButtonId: current.selectedButtonId === buttonId ? null : current.selectedButtonId,
    }));
  }, []);

  const availableButtons = useMemo(
    () => state.libraryButtons.filter((candidate) => !state.buttons.some((button) => button.id === candidate.id)),
    [state.buttons, state.libraryButtons],
  );

  const keyboard: CustomKeyboardViewModel = {
    buttons: state.buttons,
    activeModifiers,
    nativeKeyboardVisible,
    flickPreview: options.flickPreview,
    onButtonPress,
    onNativeAction,
    onNativeFileSelected: (action, file) => options.onNativeFileSelected?.(action, file),
    onToggleNativeKeyboard,
    onOpenSettings: () => setState((current) => ({ ...current, settingsOpen: true })),
  };

  const settings: CustomKeyboardSettingsViewModel = {
    buttons: state.buttons,
    availableButtons,
    shortcutButtons: state.shortcutButtons,
    selectedButtonId: state.selectedButtonId,
    repeatStartDelayMs: state.repeatStartDelayMs,
    repeatIntervalMs: state.repeatIntervalMs,
    onSelectButton: (buttonId) => setState((current) => ({ ...current, selectedButtonId: buttonId })),
    onSwapButton,
    onMoveShortcut,
    onAddButton,
    onRemoveButton,
    onRegisterShortcut,
    onUpdateShortcut,
    onDeleteShortcut,
    onRepeatStartDelayChange: (repeatStartDelayMs) => setState((current) => ({ ...current, repeatStartDelayMs })),
    onRepeatIntervalChange: (repeatIntervalMs) => setState((current) => ({ ...current, repeatIntervalMs })),
    onClose: () => setState((current) => ({ ...current, settingsOpen: false })),
    onSave: () => setState((current) => ({ ...current, settingsOpen: false })),
  };

  return {
    keyboard,
    settings,
    settingsOpen: state.settingsOpen,
    repeatStartDelayMs: state.repeatStartDelayMs,
    repeatIntervalMs: state.repeatIntervalMs,
  };
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

function nextShortcutId(buttons: readonly CustomKeyboardButton[]): string {
  const existingIds = new Set(buttons.map((button) => button.id));
  let index = buttons.length + 1;
  while (existingIds.has(`custom-shortcut-${index}`)) index += 1;
  return `custom-shortcut-${index}`;
}

function readCustomKeyboardState(): CustomKeyboardState {
  const fallback: CustomKeyboardState = {
    buttons: [...defaultCustomKeyboardButtons],
    libraryButtons: [...customKeyboardButtonLibrary],
    shortcutButtons: customKeyboardButtonLibrary.filter((button) => button.kind === "shortcut"),
    repeatStartDelayMs: 420,
    repeatIntervalMs: 180,
    selectedButtonId: defaultCustomKeyboardButtons[0]?.id ?? null,
    settingsOpen: false,
  };
  if (typeof window === "undefined") return fallback;

  try {
    const raw = window.localStorage.getItem(CUSTOM_KEYBOARD_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<PersistedCustomKeyboardState>;
    const buttons = validButtonArray(parsed.buttons) ?? fallback.buttons;
    const storedLibraryButtons = validButtonArray(parsed.libraryButtons);
    const libraryButtons = uniqueButtons([...(storedLibraryButtons ?? customKeyboardButtonLibrary), ...buttons]);
    const shortcutButtons =
      validButtonArray(parsed.shortcutButtons)?.filter((button) => button.kind === "shortcut") ??
      libraryButtons.filter((button) => button.kind === "shortcut");
    return {
      buttons,
      libraryButtons,
      shortcutButtons: uniqueButtons(shortcutButtons),
      repeatStartDelayMs: validNumber(parsed.repeatStartDelayMs, 200, 1200, 420),
      repeatIntervalMs: validNumber(parsed.repeatIntervalMs, 80, 600, 180),
      selectedButtonId: buttons[0]?.id ?? null,
      settingsOpen: false,
    };
  } catch {
    return fallback;
  }
}

function validButtonArray(value: unknown): CustomKeyboardButton[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((button): button is CustomKeyboardButton => {
    if (!button || typeof button !== "object") return false;
    const candidate = button as Partial<CustomKeyboardButton>;
    return (
      typeof candidate.id === "string" &&
      (candidate.kind === "key" || candidate.kind === "modifier" || candidate.kind === "shortcut") &&
      (candidate.category === "abc" ||
        candidate.category === "123" ||
        candidate.category === "special" ||
        candidate.category === "shortcuts") &&
      typeof candidate.accessibleLabel === "string" &&
      Array.isArray(candidate.sequence)
    );
  });
}

function validNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;
}
