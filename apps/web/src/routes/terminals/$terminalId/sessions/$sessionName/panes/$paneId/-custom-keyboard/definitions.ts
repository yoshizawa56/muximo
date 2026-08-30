import {
  customKeyboardAbcLetterRow,
  customKeyboardAbcRows,
  customKeyboardNumberRows,
  customKeyboardPunctuationRow,
} from "./layout";
import type { CustomKeyboardTerminalAction } from "./terminal-actions";
import type {
  CustomKeyboardIcon,
  CustomKeyboardKey,
  CustomKeyboardLayout,
  CustomKeyboardModifier,
  CustomKeyboardSequence,
  CustomKeyboardSequenceToken,
  CustomKeyboardSurfaceId,
} from "./viewmodel";

export type CustomKeyboardDefaultPlacement = "main" | "utility" | "surface" | "library";

export type CustomKeyboardKeyDefinition = CustomKeyboardKey & {
  defaultPlacement: CustomKeyboardDefaultPlacement;
  defaultDensity?: "regular" | "compact";
  defaultFlexGrow?: number;
  surfaceGroup?: CustomKeyboardSurfaceId;
};

export function defineKey<const T extends CustomKeyboardKeyDefinition>(definition: T): T {
  return definition;
}

function defineKeys<const T extends readonly CustomKeyboardKeyDefinition[]>(definitions: T): T {
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new Error(`Duplicate custom keyboard key id: ${definition.id}`);
    ids.add(definition.id);
  }
  return definitions;
}

function keySequence(key: string): CustomKeyboardSequence {
  return [{ type: "key", key }];
}

function textSequence(value: string): CustomKeyboardSequence {
  return [{ type: "text", value }];
}

function keyToken(key: string): CustomKeyboardSequenceToken {
  return { type: "key", key };
}

function textToken(value: string): CustomKeyboardSequenceToken {
  return { type: "text", value };
}

const canonicalNumberValues = new Set(["/", "@", "!", "'", '"']);
const numberValues = [...new Set([...customKeyboardNumberRows.base.flat(), ...customKeyboardPunctuationRow])].filter(
  (value) => !canonicalNumberValues.has(value),
);

const numberSymbolValues = [
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
] as const;

const customKeyboardKeyDefinitions = defineKeys<readonly CustomKeyboardKeyDefinition[]>([
  defineKey({
    id: "escape",
    category: "special",
    icon: "escape",
    accessibleLabel: "Escape",
    activation: { type: "sequence", sequence: keySequence("Escape") },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "tab",
    category: "special",
    icon: "tab",
    label: "Tab",
    accessibleLabel: "Tab",
    activation: { type: "sequence", sequence: keySequence("Tab") },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "enter",
    category: "special",
    label: "Enter",
    accessibleLabel: "Enter",
    activation: { type: "sequence", sequence: keySequence("Enter") },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "backspace",
    category: "special",
    label: "Bksp",
    accessibleLabel: "Backspace",
    activation: { type: "sequence", sequence: keySequence("Backspace") },
    defaultPlacement: "library",
  }),
  defineKey({
    id: "delete",
    category: "special",
    label: "Del",
    accessibleLabel: "Delete",
    activation: { type: "sequence", sequence: keySequence("Delete") },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "home",
    category: "special",
    label: "Home",
    accessibleLabel: "Home",
    activation: { type: "sequence", sequence: keySequence("Home") },
    defaultPlacement: "library",
  }),
  defineKey({
    id: "end",
    category: "special",
    label: "End",
    accessibleLabel: "End",
    activation: { type: "sequence", sequence: keySequence("End") },
    defaultPlacement: "library",
  }),
  defineKey({
    id: "page-up",
    category: "special",
    label: "PgUp",
    accessibleLabel: "Page up",
    activation: { type: "sequence", sequence: keySequence("PageUp") },
    defaultPlacement: "library",
  }),
  defineKey({
    id: "page-down",
    category: "special",
    label: "PgDn",
    accessibleLabel: "Page down",
    activation: { type: "sequence", sequence: keySequence("PageDown") },
    defaultPlacement: "library",
  }),
  defineKey({
    id: "ctrl",
    category: "special",
    icon: "control",
    label: "Ctrl",
    accessibleLabel: "Control modifier",
    activation: { type: "modifier", modifier: "ctrl" },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "alt",
    category: "special",
    icon: "option",
    label: "Alt",
    accessibleLabel: "Alt modifier",
    activation: { type: "modifier", modifier: "alt" },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "shift",
    category: "abc",
    icon: "shift",
    label: "Shift",
    accessibleLabel: "Shift modifier",
    activation: { type: "modifier", modifier: "shift" },
    defaultPlacement: "library",
  }),
  defineKey({
    id: "copy-mode",
    category: "special",
    icon: "copy",
    label: "COPY",
    accessibleLabel: "Enter tmux copy mode",
    activation: { type: "terminal", action: "enter-copy-mode" },
    defaultPlacement: "surface",
    surfaceGroup: "clipboard",
  }),
  defineKey({
    id: "paste-clipboard",
    category: "special",
    icon: "paste",
    label: "PASTE",
    accessibleLabel: "Paste from clipboard",
    activation: { type: "terminal", action: "paste-from-clipboard" },
    defaultPlacement: "surface",
    surfaceGroup: "clipboard",
  }),
  defineKey({
    id: "paste-tmux-buffer",
    category: "special",
    icon: "clipboard",
    label: "TMUX",
    accessibleLabel: "Paste from tmux buffer",
    activation: { type: "terminal", action: "paste-from-tmux-buffer" },
    defaultPlacement: "surface",
    surfaceGroup: "clipboard",
  }),
  defineKey({
    id: "slash",
    category: "123",
    icon: "slash",
    accessibleLabel: "Slash",
    activation: { type: "sequence", sequence: textSequence("/") },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "exclamation",
    category: "123",
    icon: "number",
    label: "!",
    accessibleLabel: "Exclamation mark",
    activation: { type: "sequence", sequence: textSequence("!") },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "double-quote",
    category: "123",
    icon: "quote",
    accessibleLabel: "Double quote",
    activation: { type: "sequence", sequence: textSequence('"') },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "apostrophe",
    category: "123",
    icon: "apostrophe",
    accessibleLabel: "Apostrophe",
    activation: { type: "sequence", sequence: textSequence("'") },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "pipe",
    category: "123",
    icon: "pipe",
    accessibleLabel: "Pipe",
    activation: { type: "sequence", sequence: textSequence("|") },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "tilde",
    category: "123",
    icon: "tilde",
    accessibleLabel: "Tilde",
    activation: { type: "sequence", sequence: textSequence("~") },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "at",
    category: "123",
    icon: "at",
    accessibleLabel: "At sign",
    activation: { type: "sequence", sequence: textSequence("@") },
    defaultPlacement: "main",
  }),
  defineKey({
    id: "photo-library",
    category: "special",
    icon: "plus",
    label: "ADD",
    accessibleLabel: "Add image",
    activation: { type: "native", action: "pick-photo" },
    defaultPlacement: "utility",
    defaultDensity: "compact",
  }),
  defineKey({
    id: "clipboard-surface",
    category: "special",
    icon: "clipboard",
    label: "CLIP",
    accessibleLabel: "Open copy and paste actions",
    activation: { type: "surface", surface: "clipboard" },
    defaultPlacement: "utility",
    defaultDensity: "compact",
  }),
  defineKey({
    id: "toggle-standard-keyboard",
    category: "special",
    icon: "keyboard",
    label: "KEYBOARD",
    accessibleLabel: "Show or hide the standard keyboard",
    activation: { type: "native", action: "toggle-standard-keyboard" },
    defaultPlacement: "utility",
    defaultDensity: "compact",
    defaultFlexGrow: 1,
  }),
  defineKey({
    id: "directional-flick",
    category: "special",
    icon: "directional-flick",
    label: "Arrows",
    accessibleLabel: "Arrow pad",
    activation: { type: "directional-flick" },
    defaultPlacement: "utility",
    defaultDensity: "compact",
  }),
  defineKey({
    id: "profile-surface",
    category: "special",
    icon: "settings",
    label: "PROFILE",
    accessibleLabel: "Open custom keyboard profiles and settings",
    activation: { type: "surface", surface: "profile" },
    defaultPlacement: "utility",
    defaultDensity: "compact",
  }),
  defineKey({
    id: "camera",
    category: "special",
    icon: "camera",
    label: "CAM",
    accessibleLabel: "Open camera",
    activation: { type: "native", action: "capture-photo" },
    defaultPlacement: "library",
  }),
  ...[...customKeyboardAbcRows.flat(), ...customKeyboardAbcLetterRow].map((key) =>
    defineKey({
      id: `letter-${key}`,
      category: "abc" as const,
      icon: "letter" as const,
      label: key,
      accessibleLabel: `Letter ${key.toUpperCase()}`,
      activation: { type: "sequence" as const, sequence: [keyToken(key)] },
      defaultPlacement: "library" as const,
    }),
  ),
  ...numberValues.map((value) =>
    defineKey({
      id: `number-${value}`,
      category: "123" as const,
      icon: "number" as const,
      label: value,
      accessibleLabel: `Key ${value}`,
      activation: { type: "sequence" as const, sequence: [textToken(value)] },
      defaultPlacement: "library" as const,
    }),
  ),
  ...numberSymbolValues.map(([id, value, accessibleLabel]) =>
    defineKey({
      id: `number-${id}`,
      category: "123" as const,
      icon: "number" as const,
      label: value,
      accessibleLabel,
      activation: { type: "sequence" as const, sequence: [textToken(value)] },
      defaultPlacement: "library" as const,
    }),
  ),
  defineKey({
    id: "git-status",
    category: "shortcuts",
    icon: "branch",
    accessibleLabel: "Git status shortcut",
    activation: { type: "sequence", sequence: [textToken("git status"), keyToken("Enter")] },
    defaultPlacement: "library",
  }),
  defineKey({
    id: "npm-test",
    category: "shortcuts",
    icon: "bolt",
    accessibleLabel: "Run Bun test shortcut",
    activation: { type: "sequence", sequence: [textToken("bun test"), keyToken("Enter")] },
    defaultPlacement: "library",
  }),
  defineKey({
    id: "clear-screen",
    category: "shortcuts",
    icon: "terminal",
    accessibleLabel: "Clear terminal shortcut",
    activation: { type: "sequence", sequence: [textToken("clear"), keyToken("Enter")] },
    defaultPlacement: "library",
  }),
]);

export { customKeyboardKeyDefinitions };

function keyFromDefinition(definition: CustomKeyboardKeyDefinition): CustomKeyboardKey {
  const { id, category, icon, label, accessibleLabel, activation } = definition;
  return {
    id,
    category,
    ...(icon === undefined ? {} : { icon }),
    ...(label === undefined ? {} : { label }),
    accessibleLabel,
    activation,
  };
}

export const customKeyboardKeyLibrary: readonly CustomKeyboardKey[] =
  customKeyboardKeyDefinitions.map(keyFromDefinition);

export const defaultCustomKeyboardKeys: readonly CustomKeyboardKey[] = customKeyboardKeyDefinitions
  .filter((definition) => definition.defaultPlacement === "main")
  .map(keyFromDefinition);

function defaultPlacement(definition: CustomKeyboardKeyDefinition): {
  keyId: string;
  density: "regular" | "compact";
  flexGrow?: number;
} {
  return {
    keyId: definition.id,
    density: definition.defaultDensity ?? "regular",
    ...(definition.defaultFlexGrow === undefined ? {} : { flexGrow: definition.defaultFlexGrow }),
  };
}

export const defaultCustomKeyboardLayout: CustomKeyboardLayout = {
  rows: [
    {
      id: "main",
      overflow: "scroll" as const,
      placements: customKeyboardKeyDefinitions
        .filter((definition) => definition.defaultPlacement === "main")
        .map(defaultPlacement),
    },
    {
      id: "utility",
      overflow: "stable" as const,
      placements: customKeyboardKeyDefinitions
        .filter((definition) => definition.defaultPlacement === "utility")
        .map(defaultPlacement),
    },
  ],
};

export type CustomKeyboardSpecialKeyDefinition = {
  id: string;
  key: string;
  label?: string;
  accessibleLabel: string;
  icon?: CustomKeyboardIcon;
};

export const customKeyboardSpecialKeyOptions: readonly CustomKeyboardSpecialKeyDefinition[] =
  customKeyboardKeyDefinitions.flatMap((definition) => {
    if (definition.category !== "special" || definition.activation.type !== "sequence") return [];
    const [token] = definition.activation.sequence;
    if (token?.type !== "key" || token.modifiers?.length) return [];
    return [
      {
        id: definition.id,
        key: token.key,
        ...(definition.label === undefined ? {} : { label: definition.label }),
        accessibleLabel: definition.accessibleLabel,
        ...(definition.icon === undefined ? {} : { icon: definition.icon }),
      },
    ];
  });

export type CustomKeyboardSpecialModifierDefinition = {
  id: string;
  modifier: CustomKeyboardModifier;
  icon: CustomKeyboardIcon;
  label: string;
  accessibleLabel: string;
};

export const customKeyboardSpecialModifierOptions: readonly CustomKeyboardSpecialModifierDefinition[] =
  customKeyboardKeyDefinitions.flatMap((definition) => {
    if (definition.activation.type !== "modifier" || definition.icon === undefined || definition.label === undefined) {
      return [];
    }
    return [
      {
        id: definition.id,
        modifier: definition.activation.modifier,
        icon: definition.icon,
        label: definition.label,
        accessibleLabel: definition.accessibleLabel,
      },
    ];
  });

export type CustomKeyboardTerminalActionDefinition = {
  id: string;
  action: CustomKeyboardTerminalAction;
  icon: CustomKeyboardIcon;
  label: string;
  accessibleLabel: string;
};

export const customKeyboardTerminalActionOptions: readonly CustomKeyboardTerminalActionDefinition[] =
  customKeyboardKeyDefinitions.flatMap((definition) => {
    if (definition.activation.type !== "terminal" || definition.icon === undefined || definition.label === undefined) {
      return [];
    }
    return [
      {
        id: definition.id,
        action: definition.activation.action,
        icon: definition.icon,
        label: definition.label,
        accessibleLabel: definition.accessibleLabel,
      },
    ];
  });

const customKeyboardSurfaceIds = [
  ...new Set(
    customKeyboardKeyDefinitions.flatMap((definition) =>
      definition.activation.type === "surface" ? [definition.activation.surface] : [],
    ),
  ),
] satisfies readonly CustomKeyboardSurfaceId[];

export const customKeyboardSurfaceDefinitions = customKeyboardSurfaceIds.map((id) => ({
  id,
  keyIds: customKeyboardKeyDefinitions
    .filter((definition) => definition.surfaceGroup === id)
    .map((definition) => definition.id),
}));
