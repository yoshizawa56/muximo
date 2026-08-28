import {
  type ClientControlMessage,
  decodeServerControlFrame,
  type ServerControlMessage,
  terminalProtocolVersion,
} from "@muximo/contract";

export type PaneViewportOwner = "mobile" | "desktop";

export type PaneResumeState = {
  sessionId: string;
  resumeToken: string;
  target: string;
};

export type NativeKeyboardToggleAction = "show" | "hide";

export function nativeKeyboardToggleAction(
  nativeKeyboardVisible: boolean,
  helperInputFocused: boolean,
): NativeKeyboardToggleAction {
  return nativeKeyboardVisible || helperInputFocused ? "hide" : "show";
}

export type TerminalControlErrorDisposition = "action" | "connection";

const terminalActionErrorCodes: ReadonlySet<string> = new Set([
  "not_attached",
  "mobile_claim_failed",
  "copy_mode_failed",
  "paste_tmux_buffer_failed",
  "resize_failed",
  "paste_image_too_large",
  "paste_image_unavailable",
  "paste_image_failed",
]);

export function terminalControlErrorDisposition(code: string, retryable: boolean): TerminalControlErrorDisposition {
  return !retryable && terminalActionErrorCodes.has(code) ? "action" : "connection";
}

export function createPasteImageMessage({
  name,
  mimeType,
  data,
}: {
  name: string;
  mimeType?: string;
  data: string;
}): Extract<ClientControlMessage, { type: "paste_image" }> {
  return {
    type: "paste_image",
    version: terminalProtocolVersion,
    name,
    ...(mimeType ? { mimeType } : {}),
    data,
  };
}

export function createTerminalAttachMessage({
  target,
  cols,
  rows,
  resume,
}: {
  target: string;
  cols: number;
  rows: number;
  resume?: PaneResumeState | null;
}): Extract<ClientControlMessage, { type: "attach" }> {
  return {
    type: "attach",
    version: terminalProtocolVersion,
    target,
    cols,
    rows,
    ...(resume && resume.target === target ? { sessionId: resume.sessionId, resumeToken: resume.resumeToken } : {}),
  };
}

export function resumeStateFromReady(
  message: Extract<ServerControlMessage, { type: "ready" }>,
  target: string,
): PaneResumeState {
  return {
    sessionId: message.sessionId,
    resumeToken: message.resumeToken,
    target,
  };
}

export type TerminalSessionCleanupMode = "preserve" | "detach";

export function terminalSessionCleanupMode(effectTarget: string, currentTarget: string): TerminalSessionCleanupMode {
  return effectTarget === currentTarget ? "preserve" : "detach";
}

export function handleControlMessage(
  rawMessage: string,
  handlers: {
    onReady: (message: Extract<ServerControlMessage, { type: "ready" }>) => void;
    onClosed: (message: Extract<ServerControlMessage, { type: "closed" }>) => void;
    onError: (message: { code: string; message: string; retryable: boolean }) => void;
    onViewport: (owner: PaneViewportOwner, reason: string) => void;
  },
): void {
  const decoded = decodeServerControlFrame(rawMessage);
  if (!decoded.ok) {
    handlers.onError({
      code: "invalid_control_frame",
      message: "Invalid control frame from muximod",
      retryable: false,
    });
    return;
  }

  const message = decoded.message;
  if (message.type === "ready") handlers.onReady(message);
  if (message.type === "closed") handlers.onClosed(message);
  if (message.type === "error")
    handlers.onError({ code: message.code, message: message.message, retryable: message.retryable ?? false });
  if (message.type === "viewport") handlers.onViewport(message.owner, message.reason);
}
