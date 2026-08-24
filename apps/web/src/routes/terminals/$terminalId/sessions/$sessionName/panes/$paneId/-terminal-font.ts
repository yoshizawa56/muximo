export const TERMINAL_SYMBOL_FONT_FAMILY = "Symbols Nerd Font Mono";

export const TERMINAL_FONT_FAMILY = [
  `"${TERMINAL_SYMBOL_FONT_FAMILY}"`,
  `"SFMono-Regular"`,
  `"Cascadia Code"`,
  `"Roboto Mono"`,
  "Menlo",
  "ui-monospace",
  "monospace",
].join(", ");

export async function waitForTerminalFont(fontSize: number): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;

  try {
    await document.fonts.load(`${fontSize}px "${TERMINAL_SYMBOL_FONT_FAMILY}"`);
  } catch {
    // The fallback stack still renders the terminal when a browser refuses the
    // bundled font (for example, in a restricted embedded webview).
  }
}
