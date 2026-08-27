import type { CustomKeyboardFlickDirection } from "./viewmodel";

export type CustomKeyboardDirectionalFlickPreview = {
  direction: CustomKeyboardFlickDirection;
  repeating: boolean;
};

export type CustomKeyboardDirectionalFlickRepeatConfig = {
  startDelayMs: number;
  intervalMs: number;
};

export type CustomKeyboardDirectionalFlickInputOptions = {
  onDirection: (direction: CustomKeyboardFlickDirection) => void;
  onPreviewChange?: (preview: CustomKeyboardDirectionalFlickPreview | null) => void;
  getRepeatConfig?: () => CustomKeyboardDirectionalFlickRepeatConfig;
  repeatStartDelayMs?: number;
  repeatIntervalMs?: number;
};

const DIRECTIONAL_FLICK_MIN_DISTANCE_PX = 12;
const DEFAULT_REPEAT_START_DELAY_MS = 420;
const DEFAULT_REPEAT_INTERVAL_MS = 180;

export function classifyCustomKeyboardFlick({
  dx,
  dy,
  minDistance = DIRECTIONAL_FLICK_MIN_DISTANCE_PX,
}: {
  dx: number;
  dy: number;
  minDistance?: number;
}): CustomKeyboardFlickDirection | null {
  if (Math.hypot(dx, dy) < minDistance) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? "right" : "left";
  return dy > 0 ? "down" : "up";
}

export function installCustomKeyboardDirectionalFlickInput(
  container: HTMLElement,
  options: CustomKeyboardDirectionalFlickInputOptions,
): () => void {
  let gesture: {
    pointerId: number;
    x: number;
    y: number;
    direction: CustomKeyboardFlickDirection | null;
    previewActive: boolean;
    repeatStartTimer: ReturnType<typeof setTimeout> | null;
    repeatTimer: ReturnType<typeof setInterval> | null;
  } | null = null;
  const activePointers = new Set<number>();

  const repeatConfig = (): CustomKeyboardDirectionalFlickRepeatConfig => {
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
    if (!gesture) return;
    clearRepeatTimers(gesture);
    if (gesture.previewActive) {
      gesture.previewActive = false;
      options.onPreviewChange?.(null);
    }
    gesture = null;
  };

  const stopFlick = (state: NonNullable<typeof gesture>) => {
    clearRepeatTimers(state);
    state.direction = null;
    if (state.previewActive) {
      state.previewActive = false;
      options.onPreviewChange?.(null);
    }
  };

  const emitDirection = (direction: CustomKeyboardFlickDirection) => {
    options.onDirection(direction);
  };

  const startFlick = (
    state: NonNullable<typeof gesture>,
    direction: CustomKeyboardFlickDirection,
    keepActive: boolean,
  ) => {
    if (state.direction === direction) return;
    clearRepeatTimers(state);
    state.direction = direction;
    emitDirection(direction);
    if (!keepActive) return;

    state.previewActive = true;
    options.onPreviewChange?.({ direction, repeating: false });
    state.repeatStartTimer = globalThis.setTimeout(() => {
      if (gesture !== state || state.direction !== direction) return;
      options.onPreviewChange?.({ direction, repeating: true });
      state.repeatTimer = globalThis.setInterval(() => {
        if (gesture !== state || state.direction !== direction) return;
        emitDirection(direction);
      }, repeatConfig().intervalMs);
    }, repeatConfig().startDelayMs);
  };

  const capturePointer = (event: PointerEvent) => {
    try {
      container.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is unavailable in a few embedded webviews.
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    activePointers.add(event.pointerId);
    event.preventDefault();
    if (activePointers.size > 1 || gesture) {
      clearGesture();
      return;
    }
    gesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      direction: null,
      previewActive: false,
      repeatStartTimer: null,
      repeatTimer: null,
    };
    capturePointer(event);
  };

  const onPointerMove = (event: PointerEvent) => {
    const state = gesture;
    if (!state || state.pointerId !== event.pointerId || activePointers.size !== 1) return;
    const direction = classifyCustomKeyboardFlick({
      dx: event.clientX - state.x,
      dy: event.clientY - state.y,
    });
    if (direction === state.direction) {
      if (direction) event.preventDefault();
      return;
    }
    event.preventDefault();
    if (direction) {
      startFlick(state, direction, true);
    } else {
      stopFlick(state);
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    activePointers.delete(event.pointerId);
    const state = gesture;
    if (!state || state.pointerId !== event.pointerId || activePointers.size !== 0) {
      if (activePointers.size === 0) clearGesture();
      return;
    }
    const direction = classifyCustomKeyboardFlick({
      dx: event.clientX - state.x,
      dy: event.clientY - state.y,
    });
    if (direction && direction !== state.direction) {
      event.preventDefault();
      startFlick(state, direction, false);
    }
    clearGesture();
  };

  const onPointerCancel = (event: PointerEvent) => {
    activePointers.delete(event.pointerId);
    if (activePointers.size === 0) clearGesture();
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
    activePointers.clear();
    clearGesture();
  };
}
