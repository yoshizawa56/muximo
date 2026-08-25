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
