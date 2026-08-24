import { useCallback, useEffect, useState } from "react";

const PINCH_THRESHOLD_PX = 24;
const WHEEL_GESTURE_IDLE_MS = 220;

export type PinchDirection = "in" | "out";

/**
 * Returns the direction only after the pinch has moved far enough to be a
 * deliberate gesture. A positive distance delta is a pinch-out/zoom-in.
 */
export function classifyPinchDirection(
  initialDistance: number,
  currentDistance: number,
  threshold = PINCH_THRESHOLD_PX,
): PinchDirection | null {
  const delta = currentDistance - initialDistance;
  if (Math.abs(delta) < threshold) return null;
  return delta > 0 ? "out" : "in";
}

export function isBrowserZoomKey(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;
  return ["+", "=", "-", "_", "0"].includes(event.key);
}

export function isZoomInKey(event: Pick<KeyboardEvent, "key">): boolean {
  return event.key === "+" || event.key === "=";
}

/**
 * Forms keep their normal editing behavior. xterm is intentionally excluded
 * from this check because its helper textarea is part of the terminal input
 * surface, where a pinch is still the window-map shortcut.
 */
export function isEditableGestureTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  if (target.closest(".xterm")) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'));
}

export function useWindowMapGesture(onOpen: () => void): (node: HTMLElement | null) => void {
  const [surface, setSurface] = useState<HTMLElement | null>(null);
  const surfaceRef = useCallback((node: HTMLElement | null) => setSurface(node), []);

  useEffect(() => {
    if (!surface) return;

    let pinchStartDistance: number | null = null;
    let pinchTriggered = false;
    let safariGestureActive = false;
    let safariGestureTriggered = false;
    let wheelTriggered = false;
    let wheelResetTimer: number | null = null;

    const resetTouchGesture = () => {
      pinchStartDistance = null;
      if (!safariGestureActive) {
        pinchTriggered = false;
        safariGestureTriggered = false;
      }
    };

    const resetSafariGesture = () => {
      safariGestureActive = false;
      if (pinchStartDistance === null) {
        pinchTriggered = false;
        safariGestureTriggered = false;
      }
    };

    const resetAllGestures = () => {
      resetTouchGesture();
      resetSafariGesture();
      wheelTriggered = false;
      if (wheelResetTimer !== null) {
        window.clearTimeout(wheelResetTimer);
        wheelResetTimer = null;
      }
    };

    const distanceBetweenTouches = (touches: TouchList): number | null => {
      if (touches.length < 2) return null;
      const first = touches.item(0);
      const second = touches.item(1);
      if (!first || !second) return null;
      return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
    };

    const onOpenOnce = (triggered: "touch" | "safari" | "wheel") => {
      if (triggered === "touch") {
        if (pinchTriggered || safariGestureTriggered) return;
        pinchTriggered = true;
      } else if (triggered === "safari") {
        if (safariGestureTriggered || pinchTriggered) return;
        safariGestureTriggered = true;
      } else {
        if (wheelTriggered) return;
        wheelTriggered = true;
      }
      onOpen();
    };

    const scheduleWheelReset = () => {
      if (wheelResetTimer !== null) window.clearTimeout(wheelResetTimer);
      wheelResetTimer = window.setTimeout(() => {
        wheelTriggered = false;
        wheelResetTimer = null;
      }, WHEEL_GESTURE_IDLE_MS);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (isEditableGestureTarget(event.target)) return;
      const distance = distanceBetweenTouches(event.touches);
      if (distance === null) return;
      pinchStartDistance = distance;
      if (!safariGestureActive) pinchTriggered = false;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (pinchStartDistance === null || event.touches.length < 2) return;
      const distance = distanceBetweenTouches(event.touches);
      if (distance === null) return;

      // Keep ordinary one-finger scrolling intact. Once two fingers have
      // moved, cancel only this native pinch stream so the browser cannot
      // resize the page underneath the app gesture.
      if (Math.abs(distance - pinchStartDistance) >= 4) event.preventDefault();
      if (classifyPinchDirection(pinchStartDistance, distance) === "out") onOpenOnce("touch");
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) resetTouchGesture();
    };

    const onTouchCancel = () => resetTouchGesture();

    const isSurfaceEvent = (event: Event): boolean => {
      const target = event.target;
      if (target instanceof Node && surface.contains(target)) return true;
      const activeElement = document.activeElement;
      return activeElement instanceof Node && surface.contains(activeElement);
    };

    const onSafariGestureStart = (event: Event) => {
      if (!isSurfaceEvent(event) || isEditableGestureTarget(event.target)) return;
      safariGestureActive = true;
      // Safari can emit gesture events alongside touch events. Carry the
      // touch latch across both event families so one pinch opens once.
      safariGestureTriggered = pinchTriggered;
      event.preventDefault();
    };

    const onSafariGestureChange = (event: Event) => {
      if (!safariGestureActive || !isSurfaceEvent(event)) return;
      event.preventDefault();
      const scale = (event as Event & { scale?: number }).scale;
      if (typeof scale === "number" && scale > 1.08) onOpenOnce("safari");
    };

    const onSafariGestureEnd = () => resetSafariGesture();

    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || isEditableGestureTarget(event.target)) return;
      event.preventDefault();
      onOpenOnce("wheel");
      scheduleWheelReset();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSurfaceEvent(event) || isEditableGestureTarget(event.target) || !isBrowserZoomKey(event)) return;
      event.preventDefault();
      if (isZoomInKey(event)) {
        onOpenOnce("wheel");
        scheduleWheelReset();
      }
    };

    surface.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
    surface.addEventListener("touchmove", onTouchMove, { capture: true, passive: false });
    surface.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
    surface.addEventListener("touchcancel", onTouchCancel, { capture: true, passive: true });
    surface.addEventListener("wheel", onWheel, { capture: true, passive: false });
    document.addEventListener("gesturestart", onSafariGestureStart, { passive: false });
    document.addEventListener("gesturechange", onSafariGestureChange, { passive: false });
    document.addEventListener("gestureend", onSafariGestureEnd);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", resetAllGestures);
    document.addEventListener("visibilitychange", resetAllGestures);

    return () => {
      surface.removeEventListener("touchstart", onTouchStart, true);
      surface.removeEventListener("touchmove", onTouchMove, true);
      surface.removeEventListener("touchend", onTouchEnd, true);
      surface.removeEventListener("touchcancel", onTouchCancel, true);
      surface.removeEventListener("wheel", onWheel, true);
      document.removeEventListener("gesturestart", onSafariGestureStart);
      document.removeEventListener("gesturechange", onSafariGestureChange);
      document.removeEventListener("gestureend", onSafariGestureEnd);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", resetAllGestures);
      document.removeEventListener("visibilitychange", resetAllGestures);
      if (wheelResetTimer !== null) window.clearTimeout(wheelResetTimer);
    };
  }, [onOpen, surface]);

  return surfaceRef;
}
