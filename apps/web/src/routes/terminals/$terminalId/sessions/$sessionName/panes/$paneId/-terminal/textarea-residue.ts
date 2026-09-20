export type TerminalTextareaResidueGuard = {
  acceptData: (data: string) => boolean;
  dispose: () => void;
};

export type TerminalTextareaResidueGuardOptions = {
  setTimeout?: (callback: () => void, delayMs: number) => number;
  clearTimeout?: (handle: number) => void;
  now?: () => number;
  eventSurface?: EventTarget;
};

type TerminalInputTextarea = Pick<HTMLTextAreaElement, "addEventListener" | "removeEventListener" | "value">;

const NATIVE_EVENT_CORRELATION_MS = 100;

/**
 * Prevents xterm's hidden textarea from retaining or duplicating emitted input.
 *
 * xtermjs/xterm.js#6078 documents a WebKit path that can later re-emit the
 * textarea's full retained value through onData. Related WebKit event ordering
 * can also deliver the same printable data twice. Muximo does not enable
 * screenReaderMode, so the textarea does not need to retain terminal input.
 */
export function installTerminalTextareaResidueGuard(
  textarea: TerminalInputTextarea,
  options: TerminalTextareaResidueGuardOptions = {},
): TerminalTextareaResidueGuard {
  const scheduleTimeout = options.setTimeout ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const cancelTimeout = options.clearTimeout ?? ((handle) => window.clearTimeout(handle));
  const now = options.now ?? (() => performance.now());
  const textareaTarget = textarea as unknown as EventTarget;
  const eventSurface = options.eventSurface ?? (textarea as HTMLTextAreaElement).ownerDocument ?? textareaTarget;
  let composing = false;
  let clearTimer: number | null = null;
  let disposed = false;
  let nativeInputGeneration = 0;
  let lastNativeEvent: {
    type: "input" | "keydown" | "keyup";
    at: number;
    trailingInput?: boolean;
  } | null = null;
  let lastAcceptedData: { data: string; generation: number } | null = null;

  const clearResidue = () => {
    clearTimer = null;
    if (disposed || composing) return;
    textarea.value = "";
  };

  const scheduleClear = () => {
    if (disposed || composing || clearTimer !== null) return;
    // xterm may finish processing composition or textarea-diff input in its
    // own zero-delay task. Clear in the following task, after onData has
    // delivered the committed bytes, and do not postpone a scheduled sweep.
    clearTimer = scheduleTimeout(clearResidue, 0);
  };

  const cancelScheduledClear = () => {
    if (clearTimer === null) return;
    cancelTimeout(clearTimer);
    clearTimer = null;
  };

  const handleCompositionStart = () => {
    composing = true;
    cancelScheduledClear();
  };
  const handleCompositionEnd = () => {
    composing = false;
    scheduleClear();
  };
  const handleKeyUp = () => {
    lastNativeEvent = { type: "keyup", at: now() };
    scheduleClear();
  };
  const handleBlur = () => {
    scheduleClear();
  };
  const handleKeyDown = (event: Event) => {
    if (event.target !== textareaTarget) return;
    // A keyCode=229 keydown may arrive after the input event. Keep the value
    // intact until xterm's deferred textarea-diff task has observed it.
    cancelScheduledClear();
    const timestamp = now();
    const followsInput =
      (event as KeyboardEvent).keyCode === 229 &&
      lastNativeEvent?.type === "input" &&
      timestamp - lastNativeEvent.at <= NATIVE_EVENT_CORRELATION_MS;
    if (!followsInput) nativeInputGeneration += 1;
    lastNativeEvent = { type: "keydown", at: timestamp, trailingInput: followsInput };
  };
  const handleInput = (event: Event) => {
    if (event.target !== textareaTarget) return;
    const timestamp = now();
    const followsKeyDown =
      lastNativeEvent?.type === "keydown" &&
      !lastNativeEvent.trailingInput &&
      timestamp - lastNativeEvent.at <= NATIVE_EVENT_CORRELATION_MS;
    if (!followsKeyDown) nativeInputGeneration += 1;
    lastNativeEvent = { type: "input", at: timestamp };
  };

  const acceptData = (data: string): boolean => {
    scheduleClear();
    const timestamp = now();
    const belongsToRecentNativeInput =
      lastNativeEvent !== null && timestamp - lastNativeEvent.at <= NATIVE_EVENT_CORRELATION_MS;
    if (
      belongsToRecentNativeInput &&
      isPrintableTerminalData(data) &&
      lastAcceptedData?.generation === nativeInputGeneration &&
      lastAcceptedData.data === data
    ) {
      return false;
    }
    lastAcceptedData = { data, generation: nativeInputGeneration };
    return true;
  };

  textarea.addEventListener("compositionstart", handleCompositionStart);
  textarea.addEventListener("compositionend", handleCompositionEnd);
  textarea.addEventListener("keyup", handleKeyUp);
  textarea.addEventListener("blur", handleBlur);
  eventSurface.addEventListener("keydown", handleKeyDown, true);
  eventSurface.addEventListener("input", handleInput, true);

  return {
    acceptData,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      textarea.removeEventListener("compositionstart", handleCompositionStart);
      textarea.removeEventListener("compositionend", handleCompositionEnd);
      textarea.removeEventListener("keyup", handleKeyUp);
      textarea.removeEventListener("blur", handleBlur);
      eventSurface.removeEventListener("keydown", handleKeyDown, true);
      eventSurface.removeEventListener("input", handleInput, true);
      cancelScheduledClear();
    },
  };
}

function isPrintableTerminalData(data: string): boolean {
  if (!data) return false;
  for (const character of data) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f)) return false;
  }
  return true;
}
