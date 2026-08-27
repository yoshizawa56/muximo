export type CustomKeyboardTerminalAction = "enter-copy-mode" | "paste-from-clipboard" | "paste-from-tmux-buffer";

export type CustomKeyboardTerminalActionHandlers = Record<CustomKeyboardTerminalAction, () => void>;

export function isCustomKeyboardTerminalAction(value: unknown): value is CustomKeyboardTerminalAction {
  return value === "enter-copy-mode" || value === "paste-from-clipboard" || value === "paste-from-tmux-buffer";
}

export function routeCustomKeyboardTerminalAction(
  action: CustomKeyboardTerminalAction,
  handlers: CustomKeyboardTerminalActionHandlers,
): void {
  handlers[action]();
}
