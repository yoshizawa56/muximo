import type { CustomKeyboardModifier, CustomKeyboardSequence, CustomKeyboardSequenceToken } from "./viewmodel";

export function isCustomKeyboardModifierKey(key: string): boolean {
  return key === "Control" || key === "Alt" || key === "Shift" || key === "Meta";
}

const SPECIAL_KEY_INPUT: Record<string, string> = {
  Escape: "\u001b",
  Tab: "\t",
  Enter: "\r",
  Return: "\r",
  Backspace: "\u007f",
  Delete: "\u001b[3~",
  Insert: "\u001b[2~",
  Home: "\u001b[H",
  End: "\u001b[F",
  PageUp: "\u001b[5~",
  PageDown: "\u001b[6~",
  ArrowUp: "\u001b[A",
  ArrowDown: "\u001b[B",
  ArrowRight: "\u001b[C",
  ArrowLeft: "\u001b[D",
};

const MODIFIED_CSI_KEY_INPUT: Record<string, { prefix: string; suffix: string }> = {
  Tab: { prefix: "1", suffix: "I" },
  Insert: { prefix: "2", suffix: "~" },
  Delete: { prefix: "3", suffix: "~" },
  PageUp: { prefix: "5", suffix: "~" },
  PageDown: { prefix: "6", suffix: "~" },
  ArrowUp: { prefix: "1", suffix: "A" },
  ArrowDown: { prefix: "1", suffix: "B" },
  ArrowRight: { prefix: "1", suffix: "C" },
  ArrowLeft: { prefix: "1", suffix: "D" },
  Home: { prefix: "1", suffix: "H" },
  End: { prefix: "1", suffix: "F" },
};

const CONTROL_SPECIAL_KEY_INPUT: Record<string, string> = {
  Escape: "\u001b",
  Enter: "\n",
  Return: "\n",
  Backspace: "\b",
};

const NATIVE_INPUT_KEY_BY_SEQUENCE: Record<string, string> = {
  "\r": "Enter",
  "\n": "Enter",
  "\t": "Tab",
  "\u007f": "Backspace",
  "\u0008": "Backspace",
  "\u001b[2~": "Insert",
  "\u001b[3~": "Delete",
  "\u001b[5~": "PageUp",
  "\u001b[6~": "PageDown",
  "\u001b[A": "ArrowUp",
  "\u001b[B": "ArrowDown",
  "\u001b[C": "ArrowRight",
  "\u001b[D": "ArrowLeft",
  "\u001b[H": "Home",
  "\u001b[F": "End",
  "\u001b": "Escape",
};

export function encodeCustomKeyboardSequence(
  sequence: CustomKeyboardSequence,
  activeModifiers: readonly CustomKeyboardModifier[] = [],
): string {
  return sequence
    .map((token, index) => {
      const tokenModifiers = token.type === "key" ? (token.modifiers ?? []) : [];
      const modifiers = index === 0 ? mergeModifiers(activeModifiers, tokenModifiers) : tokenModifiers;
      return encodeSequenceToken(token, modifiers);
    })
    .join("");
}

export function encodeCustomKeyboardNativeInput(
  data: string,
  activeModifiers: readonly CustomKeyboardModifier[] = [],
): string {
  if (activeModifiers.length === 0 || data.length === 0) return data;
  const key = NATIVE_INPUT_KEY_BY_SEQUENCE[data];
  return key
    ? encodeCustomKeyboardSequence([{ type: "key", key }], activeModifiers)
    : encodeCustomKeyboardSequence([{ type: "text", value: data }], activeModifiers);
}

function encodeSequenceToken(token: CustomKeyboardSequenceToken, modifiers: readonly CustomKeyboardModifier[]): string {
  if (token.type === "text") return encodeText(token.value, modifiers);
  return encodeKey(token.key, modifiers);
}

function encodeText(value: string, modifiers: readonly CustomKeyboardModifier[]): string {
  let nextValue = modifiers.includes("shift") ? value.toUpperCase() : value;
  if (modifiers.includes("ctrl") && nextValue.length === 1) {
    nextValue = controlCharacter(nextValue) ?? nextValue;
  }
  return modifiers.includes("alt") ? `\u001b${nextValue}` : nextValue;
}

function encodeKey(key: string, modifiers: readonly CustomKeyboardModifier[]): string {
  if (modifiers.includes("shift") && key === "Tab" && !modifiers.includes("ctrl") && !modifiers.includes("alt")) {
    return "\u001b[Z";
  }

  const modifiedCsiKey = MODIFIED_CSI_KEY_INPUT[key];
  if (modifiedCsiKey && (modifiers.includes("ctrl") || modifiers.includes("shift"))) {
    return `\u001b[${modifiedCsiKey.prefix};${modifierParameter(modifiers)}${modifiedCsiKey.suffix}`;
  }

  let nextValue = SPECIAL_KEY_INPUT[key] ?? key;
  if (modifiers.includes("shift") && key.length === 1) nextValue = key.toUpperCase();
  if (modifiers.includes("ctrl")) nextValue = controlCharacter(key) ?? CONTROL_SPECIAL_KEY_INPUT[key] ?? nextValue;
  return modifiers.includes("alt") ? `\u001b${nextValue}` : nextValue;
}

function modifierParameter(modifiers: readonly CustomKeyboardModifier[]): number {
  return (
    1 +
    (modifiers.includes("shift") ? 1 : 0) +
    (modifiers.includes("alt") ? 2 : 0) +
    (modifiers.includes("ctrl") ? 4 : 0)
  );
}

function mergeModifiers(
  activeModifiers: readonly CustomKeyboardModifier[],
  tokenModifiers: readonly CustomKeyboardModifier[],
): readonly CustomKeyboardModifier[] {
  return [...new Set([...activeModifiers, ...tokenModifiers])];
}

function controlCharacter(value: string): string | null {
  if (value.length !== 1) return null;
  const character = value.toUpperCase();
  const code = character.charCodeAt(0);
  if (code >= 65 && code <= 90) return String.fromCharCode(code - 64);
  return (
    {
      "@": "\u0000",
      "[": "\u001b",
      "\\": "\u001c",
      "]": "\u001d",
      "^": "\u001e",
      _: "\u001f",
      "?": "\u007f",
      " ": "\u0000",
    }[value] ?? null
  );
}
