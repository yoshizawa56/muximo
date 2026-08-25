export type TerminalFlickDirection = "up" | "down" | "left" | "right";
export type TerminalMouseWheelDirection = "up" | "down";

export type TerminalFlickPreview = {
  direction: TerminalFlickDirection;
  xPercent: number;
  yPercent: number;
  repeating: boolean;
  startDelayMs: number;
  intervalMs: number;
};

export type TerminalFlickRepeatConfig = {
  startDelayMs: number;
  intervalMs: number;
};

export type TerminalFlickInputOptions = {
  onGestureStart?: () => void;
  onScroll?: (deltaY: number, clientX: number, clientY: number) => void;
  onPreviewChange?: (preview: TerminalFlickPreview | null) => void;
  repeatStartDelayMs?: number;
  repeatIntervalMs?: number;
  getRepeatConfig?: () => TerminalFlickRepeatConfig;
};

const TERMINAL_FLICK_MOVE_TOLERANCE_PX = 12;
const TERMINAL_FLICK_SCROLL_DECISION_MS = 220;
const DEFAULT_REPEAT_START_DELAY_MS = 420;
const DEFAULT_REPEAT_INTERVAL_MS = 180;

const ARROW_INPUT: Record<TerminalFlickDirection, string> = {
  up: "\u001b[A",
  down: "\u001b[B",
  right: "\u001b[C",
  left: "\u001b[D",
};

export function classifyTerminalFlick({
  dx,
  dy,
  durationMs,
}: {
  dx: number;
  dy: number;
  durationMs: number;
}): TerminalFlickDirection | null {
  const distance = Math.hypot(dx, dy);
  const duration = Math.max(durationMs, 1);
  const velocity = distance / duration;

  // A slow/short drag belongs to terminal scrolling.
  if (distance < 28 || duration > 420 || velocity < 0.12) return null;

  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export function terminalInputForFlick(direction: TerminalFlickDirection): string {
  return ARROW_INPUT[direction];
}

export function terminalMouseWheelInput(direction: TerminalMouseWheelDirection, column: number, row: number): string {
  const button = direction === "up" ? 64 : 65;
  return `\u001b[<${button};${Math.max(1, Math.round(column))};${Math.max(1, Math.round(row))}M`;
}

export function installTerminalFlickInput(
  container: HTMLElement,
  onInput: (data: string) => void,
  options: TerminalFlickInputOptions = {},
): () => void {
  let gesture: {
    pointerId: number;
    x: number;
    y: number;
    lastY: number;
    startedAt: number;
    didScroll: boolean;
    flickDirection: TerminalFlickDirection | null;
    repeatStarted: boolean;
    repeatStartTimer: ReturnType<typeof setTimeout> | null;
    repeatTimer: ReturnType<typeof setInterval> | null;
  } | null = null;
  const activeTouchPointers = new Set<number>();

  const repeatConfig = (): TerminalFlickRepeatConfig => {
    const configured = options.getRepeatConfig?.() ?? {
      startDelayMs: options.repeatStartDelayMs ?? DEFAULT_REPEAT_START_DELAY_MS,
      intervalMs: options.repeatIntervalMs ?? DEFAULT_REPEAT_INTERVAL_MS,
    };
    return {
      startDelayMs: Math.max(0, configured.startDelayMs),
      intervalMs: Math.max(16, configured.intervalMs),
    };
  };

  const clearRepeatTimers = (state: NonNullable<typeof gesture>) => {
    if (state.repeatStartTimer !== null) globalThis.clearTimeout(state.repeatStartTimer);
    if (state.repeatTimer !== null) globalThis.clearInterval(state.repeatTimer);
    state.repeatStartTimer = null;
    state.repeatTimer = null;
  };

  const clearGesture = () => {
    if (gesture) clearRepeatTimers(gesture);
    options.onPreviewChange?.(null);
    gesture = null;
  };

  const previewAt = (
    direction: TerminalFlickDirection,
    x: number,
    y: number,
    repeating: boolean,
    config: TerminalFlickRepeatConfig,
  ): TerminalFlickPreview => {
    const rect = container.getBoundingClientRect?.() ?? ({ left: 0, top: 0, width: 0, height: 0 } as DOMRect);
    const xPercent = rect.width > 0 ? ((x - rect.left) / rect.width) * 100 : 50;
    const yPercent = rect.height > 0 ? ((y - rect.top) / rect.height) * 100 : 50;
    return {
      direction,
      xPercent: Math.min(100, Math.max(0, xPercent)),
      yPercent: Math.min(100, Math.max(0, yPercent)),
      repeating,
      startDelayMs: config.startDelayMs,
      intervalMs: config.intervalMs,
    };
  };

  const startFlick = (
    state: NonNullable<typeof gesture>,
    direction: TerminalFlickDirection,
    x: number,
    y: number,
    event?: Event,
  ) => {
    if (state.flickDirection) return;
    const config = repeatConfig();
    state.flickDirection = direction;
    state.didScroll = true;
    event?.preventDefault();
    onInput(terminalInputForFlick(direction));
    options.onPreviewChange?.(previewAt(direction, x, y, false, config));
    state.repeatStartTimer = globalThis.setTimeout(() => {
      if (gesture !== state || state.flickDirection !== direction) return;
      state.repeatStarted = true;
      options.onPreviewChange?.(previewAt(direction, x, y, true, config));
      state.repeatTimer = globalThis.setInterval(() => {
        if (gesture !== state || state.flickDirection !== direction) return;
        onInput(terminalInputForFlick(direction));
      }, config.intervalMs);
    }, config.startDelayMs);
  };

  const capturePointer = (event: PointerEvent) => {
    try {
      container.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in a few embedded webviews. The
      // pointer lifecycle still works while the finger remains on the view.
    }
  };

  const sendFlickIfApplicable = (
    state: NonNullable<typeof gesture>,
    x: number,
    y: number,
    durationMs: number,
    event?: Event,
  ) => {
    if (state.didScroll) return;
    const direction = classifyTerminalFlick({
      dx: x - state.x,
      dy: y - state.y,
      durationMs,
    });
    if (!direction) return;

    event?.preventDefault();
    if ((direction === "up" || direction === "down") && options.onScroll) {
      state.didScroll = true;
      options.onScroll(y - state.y, x, y);
      return;
    }
    startFlick(state, direction, x, y, event);
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    activeTouchPointers.add(event.pointerId);
    if (activeTouchPointers.size > 1 || gesture) {
      // A pinch must never finish the first finger's pending flick and send
      // an arrow key to the terminal.
      clearGesture();
      return;
    }
    const startedAt = performance.now();
    gesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastY: event.clientY,
      startedAt,
      didScroll: false,
      flickDirection: null,
      repeatStarted: false,
      repeatStartTimer: null,
      repeatTimer: null,
    };
    options.onGestureStart?.();
    capturePointer(event);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    const state = gesture;
    if (!state || state.pointerId !== event.pointerId || activeTouchPointers.size !== 1) return;

    const now = performance.now();
    const previousY = state.lastY;
    const totalDx = event.clientX - state.x;
    const totalDy = event.clientY - state.y;
    const totalDistance = Math.hypot(totalDx, totalDy);
    const isVerticalDrag = Math.abs(totalDy) > Math.abs(totalDx) && totalDistance > TERMINAL_FLICK_MOVE_TOLERANCE_PX;

    if (!state.flickDirection && options.onScroll && isVerticalDrag) {
      const flick = classifyTerminalFlick({ dx: totalDx, dy: totalDy, durationMs: now - state.startedAt });
      if (state.didScroll || now - state.startedAt > TERMINAL_FLICK_SCROLL_DECISION_MS || !flick) {
        const wasScrolling = state.didScroll;
        state.didScroll = true;
        event.preventDefault();
        options.onScroll(event.clientY - (wasScrolling ? previousY : state.y), event.clientX, event.clientY);
      }
    }

    if (!state.didScroll && !state.flickDirection) {
      const flick = classifyTerminalFlick({ dx: totalDx, dy: totalDy, durationMs: now - state.startedAt });
      if (flick && (!options.onScroll || !isVerticalDrag)) {
        startFlick(state, flick, event.clientX, event.clientY, event);
      }
    }

    if (state.flickDirection) {
      const config = repeatConfig();
      options.onPreviewChange?.(
        previewAt(state.flickDirection, event.clientX, event.clientY, state.repeatStarted, config),
      );
    }

    state.lastY = event.clientY;
  };

  const onPointerUp = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    activeTouchPointers.delete(event.pointerId);
    const state = gesture;
    if (!state || state.pointerId !== event.pointerId || activeTouchPointers.size !== 0) {
      if (activeTouchPointers.size === 0) clearGesture();
      return;
    }

    clearGesture();
    sendFlickIfApplicable(state, event.clientX, event.clientY, performance.now() - state.startedAt, event);
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    activeTouchPointers.delete(event.pointerId);
    // A cancel can mean backgrounding, rotation, palm rejection, or an OS
    // gesture taking ownership. It is never a completed terminal input.
    if (activeTouchPointers.size === 0) clearGesture();
  };

  container.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
  container.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  container.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
  container.addEventListener("pointercancel", onPointerCancel, { capture: true, passive: false });

  return () => {
    container.removeEventListener("pointerdown", onPointerDown, true);
    container.removeEventListener("pointermove", onPointerMove, true);
    container.removeEventListener("pointerup", onPointerUp, true);
    container.removeEventListener("pointercancel", onPointerCancel, true);
    activeTouchPointers.clear();
    clearGesture();
  };
}
