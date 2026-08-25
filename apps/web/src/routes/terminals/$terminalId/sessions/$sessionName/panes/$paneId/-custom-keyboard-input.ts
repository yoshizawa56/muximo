import type {
  CustomKeyboardModifier,
  CustomKeyboardSequence,
  CustomKeyboardSequenceToken,
} from "./-custom-keyboard-viewmodel";

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
  if (modifiers.includes("shift") && key === "Tab") return "\u001b[Z";

  let nextValue = SPECIAL_KEY_INPUT[key] ?? key;
  if (modifiers.includes("shift") && key.length === 1) nextValue = key.toUpperCase();
  if (modifiers.includes("ctrl")) nextValue = controlCharacter(key) ?? nextValue;
  return modifiers.includes("alt") ? `\u001b${nextValue}` : nextValue;
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
