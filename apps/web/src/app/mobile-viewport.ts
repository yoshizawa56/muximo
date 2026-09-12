import { useEffect, useRef } from "react";
import { muximoBridge } from "../platform/muximo-bridge";

const VIEWPORT_SETTLE_MAX_MS = 2_000;
const VIEWPORT_SETTLE_STABLE_FRAMES = 4;
const KEYBOARD_INPUT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

export type MobileViewportHeightInput = {
  visualViewportHeight?: number;
  layoutViewportHeight?: number;
  recoveringFromKeyboard?: boolean;
  minimumHeight?: number;
};

export type StaleResizeGuardState = {
  active: boolean;
  minimumHeight?: number;
};

/**
 * Returns whether a focus transition came from an element that can open the
 * software keyboard. Buttons and links also emit focusout, but their blur is
 * not evidence that the keyboard was dismissed.
 */
export function isMobileViewportTextEntryElement(element: Element | null): boolean {
  if (!element) return false;
  const contentEditable = element.getAttribute("contenteditable")?.trim().toLowerCase();
  if (contentEditable === "" || contentEditable === "true" || contentEditable === "plaintext-only") return true;
  if ((element as Element & { isContentEditable?: boolean }).isContentEditable === true) return true;

  const tagName = element.tagName.toLowerCase();
  if (tagName === "textarea" || tagName === "select") return true;
  if (tagName !== "input") return false;

  const type = element.getAttribute("type")?.trim().toLowerCase() || "text";
  return (
    KEYBOARD_INPUT_TYPES.has(type) ||
    (typeof HTMLInputElement !== "undefined" &&
      element instanceof HTMLInputElement &&
      KEYBOARD_INPUT_TYPES.has(element.type.toLowerCase()))
  );
}

export function resolveStaleResizeGuard(
  observedViewportHeight: number | undefined,
  recoveryFloor: number | null,
): StaleResizeGuardState {
  const observedHeight = validViewportHeight(observedViewportHeight);
  const floor = validViewportHeight(recoveryFloor ?? undefined);
  const active = floor !== null && (observedHeight === null || observedHeight < floor);
  return { active, minimumHeight: active ? floor : undefined };
}

/**
 * Resolves the CSS app height from the two browser viewport measurements.
 * During a keyboard dismissal WebKit can deliver a late, stale visual
 * viewport height after the layout viewport has already recovered. Keep the
 * recovered layout height as a floor until the visual viewport itself reaches
 * it, so a stale measurement cannot permanently clip the shell below the
 * fold.
 */
export function resolveMobileViewportHeight({
  visualViewportHeight,
  layoutViewportHeight,
  recoveringFromKeyboard = false,
  minimumHeight,
}: MobileViewportHeightInput): number {
  const visualHeight = validViewportHeight(visualViewportHeight);
  const layoutHeight = validViewportHeight(layoutViewportHeight);

  if (visualHeight === null && layoutHeight === null) return 1;
  const resolvedHeight =
    visualHeight === null
      ? (layoutHeight ?? 1)
      : layoutHeight === null
        ? visualHeight
        : recoveringFromKeyboard
          ? Math.max(visualHeight, layoutHeight)
          : visualHeight;
  const minimum = validViewportHeight(minimumHeight);
  return minimum === null ? resolvedHeight : Math.max(resolvedHeight, minimum);
}

function validViewportHeight(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Keep CSS in sync with the visual viewport when browser chrome or the
 * software keyboard changes the usable height. `dvh` remains the fallback for
 * browsers without VisualViewport support.
 */
export function useMobileViewportHeight(): void {
  const recoveryFrameRef = useRef<number | null>(null);
  const recoveringFromKeyboardRef = useRef(false);
  const recoveryFloorRef = useRef<number | null>(null);
  const recoveryViewportShapeRef = useRef<{
    width: number;
    orientation: "portrait" | "landscape";
  } | null>(null);
  const lastLayoutViewportRef = useRef<{
    height: number;
    width: number;
    orientation: "portrait" | "landscape";
  } | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    const visualViewport = window.visualViewport;
    const cancelSettle = () => {
      if (recoveryFrameRef.current === null) return;
      window.cancelAnimationFrame(recoveryFrameRef.current);
      recoveryFrameRef.current = null;
    };
    const setHeight = (height: number) => {
      root.style.setProperty("--app-viewport-height", `${Math.max(1, Math.round(height))}px`);
    };
    const layoutViewport = () => {
      const height = Math.max(window.innerHeight, document.documentElement.clientHeight);
      const width = Math.max(window.innerWidth, document.documentElement.clientWidth);
      return {
        height,
        width,
        orientation: width >= height ? ("landscape" as const) : ("portrait" as const),
      };
    };
    const layoutHeight = () => layoutViewport().height;
    const isTextEntryActive = () => isMobileViewportTextEntryElement(document.activeElement);
    const rememberLayoutViewport = (layout: ReturnType<typeof layoutViewport>) => {
      const previous = lastLayoutViewportRef.current;
      if (previous && previous.width === layout.width && previous.orientation === layout.orientation) {
        lastLayoutViewportRef.current = { ...layout, height: Math.max(previous.height, layout.height) };
        return;
      }
      lastLayoutViewportRef.current = layout;
    };
    const update = () => {
      const layout = layoutViewport();
      const recoveryShape = recoveryViewportShapeRef.current;
      if (recoveryShape && (recoveryShape.width !== layout.width || recoveryShape.orientation !== layout.orientation)) {
        recoveryFloorRef.current = null;
        recoveryViewportShapeRef.current = null;
      }
      const staleResizeGuard = resolveStaleResizeGuard(
        visualViewport?.height ?? layout.height,
        recoveryFloorRef.current,
      );
      if (recoveryFloorRef.current !== null && !staleResizeGuard.active) {
        recoveryFloorRef.current = null;
        recoveryViewportShapeRef.current = null;
      }
      const height = resolveMobileViewportHeight({
        visualViewportHeight: visualViewport?.height,
        layoutViewportHeight: layout.height,
        recoveringFromKeyboard: recoveringFromKeyboardRef.current || staleResizeGuard.active,
        minimumHeight: staleResizeGuard.minimumHeight,
      });
      setHeight(height);
      if (!recoveringFromKeyboardRef.current && !staleResizeGuard.active && !isTextEntryActive()) {
        rememberLayoutViewport(layout);
      }
    };
    const settleAfterViewportTransition = (recoverFromKeyboard = false) => {
      cancelSettle();
      recoveringFromKeyboardRef.current = recoverFromKeyboard;
      if (recoverFromKeyboard) {
        const layout = layoutViewport();
        const previous = lastLayoutViewportRef.current;
        const previousHeight =
          previous && previous.width === layout.width && previous.orientation === layout.orientation
            ? previous.height
            : 0;
        const visualHeight = validViewportHeight(visualViewport?.height) ?? 0;
        recoveryFloorRef.current = Math.max(layout.height, previousHeight, visualHeight);
        recoveryViewportShapeRef.current = { width: layout.width, orientation: layout.orientation };
      } else if (
        recoveryFloorRef.current !== null &&
        !resolveStaleResizeGuard(visualViewport?.height ?? layoutHeight(), recoveryFloorRef.current).active
      ) {
        recoveryFloorRef.current = null;
        recoveryViewportShapeRef.current = null;
      }
      update();
      const startedAt = performance.now();
      let previousHeight = visualViewport?.height ?? window.innerHeight;
      let stableFrames = 0;
      const sample = () => {
        recoveryFrameRef.current = null;
        if (document.visibilityState !== "visible") return;
        const height = visualViewport?.height ?? window.innerHeight;
        const floor = layoutHeight();
        const staleResizeGuard = resolveStaleResizeGuard(height, recoveryFloorRef.current);
        if (recoveryFloorRef.current !== null && !staleResizeGuard.active) {
          recoveryFloorRef.current = null;
          recoveryViewportShapeRef.current = null;
        }
        setHeight(
          resolveMobileViewportHeight({
            visualViewportHeight: height,
            layoutViewportHeight: floor,
            recoveringFromKeyboard: recoveringFromKeyboardRef.current || staleResizeGuard.active,
            minimumHeight: staleResizeGuard.minimumHeight,
          }),
        );

        if (isTextEntryActive() && !recoveringFromKeyboardRef.current) {
          // A toolbar action may briefly move focus away from xterm and then
          // restore it while the keyboard remains open. The focus-in handler
          // clears recovery in that case, allowing the visual viewport to
          // control the app height again. A focusout frame that still sees the
          // old focused element continues to the recovery sampling below.
          return;
        }
        if (Math.abs(height - previousHeight) < 1) stableFrames += 1;
        else stableFrames = 0;
        previousHeight = height;

        // Wait for real viewport stability instead of assuming that a fixed
        // timer covers every WKWebView keyboard/scene transition. The layout
        // viewport is the final recovery floor once the keyboard is gone.
        if (
          height >= floor ||
          stableFrames >= VIEWPORT_SETTLE_STABLE_FRAMES ||
          performance.now() - startedAt >= VIEWPORT_SETTLE_MAX_MS
        ) {
          const finalGuard = resolveStaleResizeGuard(height, recoveryFloorRef.current);
          setHeight(
            resolveMobileViewportHeight({
              visualViewportHeight: height,
              layoutViewportHeight: floor,
              recoveringFromKeyboard: recoveringFromKeyboardRef.current || finalGuard.active,
              minimumHeight: finalGuard.minimumHeight,
            }),
          );
          recoveringFromKeyboardRef.current = false;
          if (!finalGuard.active) {
            recoveryFloorRef.current = null;
            recoveryViewportShapeRef.current = null;
          }
          if (!isTextEntryActive() && !finalGuard.active) rememberLayoutViewport(layoutViewport());
          return;
        }
        recoveryFrameRef.current = window.requestAnimationFrame(sample);
      };
      recoveryFrameRef.current = window.requestAnimationFrame(sample);
    };
    const handleFocusIn = (event: FocusEvent) => {
      if (!isMobileViewportTextEntryElement(event.target instanceof Element ? event.target : null)) return;
      recoveringFromKeyboardRef.current = false;
      recoveryFloorRef.current = null;
      recoveryViewportShapeRef.current = null;
      update();
    };
    const handleFocusOut = (event: FocusEvent) => {
      if (!isMobileViewportTextEntryElement(event.target instanceof Element ? event.target : null)) return;
      settleAfterViewportTransition(true);
    };
    const handleVisibilityChange = () => settleAfterViewportTransition();
    const handlePageshow = () => settleAfterViewportTransition();
    const handleOrientationChange = () => {
      // A keyboard recovery floor from the previous orientation must not
      // enlarge the shell after a rotation.
      lastLayoutViewportRef.current = null;
      recoveryFloorRef.current = null;
      recoveryViewportShapeRef.current = null;
      settleAfterViewportTransition();
    };

    update();
    window.addEventListener("resize", update);
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageshow);
    window.addEventListener("orientationchange", handleOrientationChange);
    const removeAppStateListener = muximoBridge.onAppStateChange((state) => {
      if (state === "active") settleAfterViewportTransition();
      else cancelSettle();
    });

    return () => {
      cancelSettle();
      recoveringFromKeyboardRef.current = false;
      recoveryFloorRef.current = null;
      recoveryViewportShapeRef.current = null;
      lastLayoutViewportRef.current = null;
      window.removeEventListener("resize", update);
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageshow);
      window.removeEventListener("orientationchange", handleOrientationChange);
      removeAppStateListener();
      root.style.removeProperty("--app-viewport-height");
    };
  }, []);
}
