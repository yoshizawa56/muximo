export type TerminalFlickDirection = "up" | "down" | "left" | "right";
export type TerminalMouseWheelDirection = "up" | "down";

export type TerminalFlickInputOptions = {
  onGestureStart?: () => void;
  onScroll?: (deltaY: number, clientX: number, clientY: number) => void;
};

const TERMINAL_FLICK_MOVE_TOLERANCE_PX = 12;
const TERMINAL_FLICK_SCROLL_DECISION_MS = 220;

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
  } | null = null;
  const activeTouchPointers = new Set<number>();

  const clearGesture = () => {
    gesture = null;
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
      options.onScroll(y - state.y, x, y);
      return;
    }
    onInput(terminalInputForFlick(direction));
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

    if (options.onScroll && isVerticalDrag) {
      const flick = classifyTerminalFlick({ dx: totalDx, dy: totalDy, durationMs: now - state.startedAt });
      if (state.didScroll || now - state.startedAt > TERMINAL_FLICK_SCROLL_DECISION_MS || !flick) {
        const wasScrolling = state.didScroll;
        state.didScroll = true;
        event.preventDefault();
        options.onScroll(event.clientY - (wasScrolling ? previousY : state.y), event.clientX, event.clientY);
      }
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
