import { useEffect, useRef } from "react";
import { muximoBridge } from "../platform/muximo-bridge";

const VIEWPORT_SETTLE_MAX_MS = 2_000;
const VIEWPORT_SETTLE_STABLE_FRAMES = 4;

/**
 * Keep CSS in sync with the visual viewport when browser chrome or the
 * software keyboard changes the usable height. `dvh` remains the fallback for
 * browsers without VisualViewport support.
 */
export function useMobileViewportHeight(): void {
  const recoveryFrameRef = useRef<number | null>(null);

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
    const layoutHeight = () => Math.max(window.innerHeight, document.documentElement.clientHeight);
    const update = () => {
      const height = visualViewport?.height ?? window.innerHeight;
      setHeight(height);
    };
    const isTextEntryActive = () => {
      const activeElement = document.activeElement;
      return (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLSelectElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.getAttribute("contenteditable") === "true"
      );
    };
    const settleAfterViewportTransition = () => {
      cancelSettle();
      update();
      const startedAt = performance.now();
      let previousHeight = visualViewport?.height ?? window.innerHeight;
      let stableFrames = 0;
      const sample = () => {
        recoveryFrameRef.current = null;
        if (document.visibilityState !== "visible") return;
        const height = visualViewport?.height ?? window.innerHeight;
        const floor = layoutHeight();
        setHeight(height);

        if (isTextEntryActive()) return;
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
          setHeight(Math.max(height, floor));
          return;
        }
        recoveryFrameRef.current = window.requestAnimationFrame(sample);
      };
      recoveryFrameRef.current = window.requestAnimationFrame(sample);
    };
    const handleFocusOut = () => settleAfterViewportTransition();

    update();
    window.addEventListener("resize", update);
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    document.addEventListener("focusout", handleFocusOut, true);
    document.addEventListener("visibilitychange", settleAfterViewportTransition);
    window.addEventListener("pageshow", settleAfterViewportTransition);
    window.addEventListener("orientationchange", settleAfterViewportTransition);
    const removeAppStateListener = muximoBridge.onAppStateChange((state) => {
      if (state === "active") settleAfterViewportTransition();
      else cancelSettle();
    });

    return () => {
      cancelSettle();
      window.removeEventListener("resize", update);
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
      document.removeEventListener("focusout", handleFocusOut, true);
      document.removeEventListener("visibilitychange", settleAfterViewportTransition);
      window.removeEventListener("pageshow", settleAfterViewportTransition);
      window.removeEventListener("orientationchange", settleAfterViewportTransition);
      removeAppStateListener();
      root.style.removeProperty("--app-viewport-height");
    };
  }, []);
}
