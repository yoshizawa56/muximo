export const customKeyboardAbcRows = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
] as const;

export const customKeyboardAbcLetterRow = ["z", "x", "c", "v", "b", "n", "m"] as const;

export const customKeyboardNumberRows = {
  base: [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["-", "/", ":", ";", "(", ")", "$", "&", "@", '"'],
  ],
  shifted: [
    ["[", "]", "{", "}", "#", "%", "^", "*", "+", "="],
    ["_", "\\", "|", "~", "<", ">", "€", "£", "¥", "•"],
  ],
} as const;

export const customKeyboardPunctuationRow = [".", ",", "?", "!", "'"] as const;
