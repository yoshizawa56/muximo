export type TerminalMouseWheelDirection = "up" | "down";

export type TerminalTouchInputOptions = {
  onGestureStart?: () => void;
  onScroll?: (deltaY: number, clientX: number, clientY: number) => void;
  /** Prevents xterm's native focus, text selection, and context menu handling. */
  suppressNativeTouch?: boolean;
};

const TERMINAL_TOUCH_MOVE_TOLERANCE_PX = 12;

export function terminalMouseWheelInput(direction: TerminalMouseWheelDirection, column: number, row: number): string {
  const button = direction === "up" ? 64 : 65;
  return `\u001b[<${button};${Math.max(1, Math.round(column))};${Math.max(1, Math.round(row))}M`;
}

/**
 * Keeps touch input out of xterm's compatibility mouse events. Touches are
 * intentionally limited to vertical scrolling; terminal keys remain
 * available through xterm and the custom keyboard.
 */
export function installTerminalTouchInput(container: HTMLElement, options: TerminalTouchInputOptions = {}): () => void {
  const suppressNativeTouch = options.suppressNativeTouch ?? true;
  let gesture: {
    pointerId: number;
    x: number;
    y: number;
    lastY: number;
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

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;

    // xterm focuses its helper textarea from the compatibility mousedown
    // generated for a touch. Shell touch input is handled by this gesture
    // layer, so do not let a shell tap open or close the native keyboard.
    if (suppressNativeTouch) event.preventDefault();
    activeTouchPointers.add(event.pointerId);
    if (activeTouchPointers.size > 1 || gesture) {
      // A multi-touch sequence is not a terminal scroll gesture.
      clearGesture();
      return;
    }

    const state = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastY: event.clientY,
      didScroll: false,
    };
    gesture = state;
    options.onGestureStart?.();
    capturePointer(event);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    const state = gesture;
    if (!state || state.pointerId !== event.pointerId || activeTouchPointers.size !== 1) return;

    const totalDx = event.clientX - state.x;
    const totalDy = event.clientY - state.y;
    const totalDistance = Math.hypot(totalDx, totalDy);

    if (Math.abs(totalDy) > Math.abs(totalDx) && totalDistance > TERMINAL_TOUCH_MOVE_TOLERANCE_PX) {
      const deltaY = event.clientY - state.lastY;
      state.didScroll = true;
      event.preventDefault();
      if (deltaY !== 0) options.onScroll?.(deltaY, event.clientX, event.clientY);
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

    const totalDx = event.clientX - state.x;
    const totalDy = event.clientY - state.y;
    if (
      !state.didScroll &&
      options.onScroll &&
      Math.abs(totalDy) > Math.abs(totalDx) &&
      Math.hypot(totalDx, totalDy) > TERMINAL_TOUCH_MOVE_TOLERANCE_PX
    ) {
      // Some iOS webviews deliver a quick flick as pointerdown/pointerup
      // without an intermediate pointermove. Preserve scrolling for that
      // event stream instead of treating it as a tap.
      state.didScroll = true;
      event.preventDefault();
      options.onScroll(totalDy, event.clientX, event.clientY);
    }
    if (state.didScroll || suppressNativeTouch) event.preventDefault();
    clearGesture();
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerType === "mouse") return;
    activeTouchPointers.delete(event.pointerId);
    // A cancel can mean backgrounding, rotation, palm rejection, or an OS
    // gesture taking ownership. It is never a completed terminal action.
    if (activeTouchPointers.size === 0) clearGesture();
  };

  const onTouchStart = (event: TouchEvent) => {
    // Prevent WebKit from synthesizing a mousedown that focuses xterm's
    // helper textarea. Pointer events remain the source of gesture state.
    if (suppressNativeTouch) event.preventDefault();
  };

  const onTouchMove = (event: TouchEvent) => {
    // Shell scrolling is handled by this touch layer. This also prevents
    // WebKit's native text-selection loupe from taking over in shell mode.
    if (suppressNativeTouch) event.preventDefault();
  };

  const onContextMenu = (event: MouseEvent) => {
    if (suppressNativeTouch) event.preventDefault();
  };

  container.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
  container.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  container.addEventListener("pointerup", onPointerUp, { capture: true, passive: false });
  container.addEventListener("pointercancel", onPointerCancel, { capture: true, passive: false });
  container.addEventListener("touchstart", onTouchStart, { capture: true, passive: false });
  container.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
  container.addEventListener("contextmenu", onContextMenu, { capture: true, passive: false });

  return () => {
    container.removeEventListener("pointerdown", onPointerDown, true);
    container.removeEventListener("pointermove", onPointerMove, true);
    container.removeEventListener("pointerup", onPointerUp, true);
    container.removeEventListener("pointercancel", onPointerCancel, true);
    container.removeEventListener("touchstart", onTouchStart, true);
    container.removeEventListener("touchmove", onTouchMove, true);
    container.removeEventListener("contextmenu", onContextMenu, true);
    activeTouchPointers.clear();
    clearGesture();
  };
}
