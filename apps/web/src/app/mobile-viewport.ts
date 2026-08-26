import { useEffect, useRef } from "react";

const KEYBOARD_RECOVERY_DELAYS_MS = [120, 300, 600] as const;

/**
 * Keep CSS in sync with the visual viewport when browser chrome or the
 * software keyboard changes the usable height. `dvh` remains the fallback for
 * browsers without VisualViewport support.
 */
export function useMobileViewportHeight(): void {
  const recoveryTimersRef = useRef<number[]>([]);

  useEffect(() => {
    const root = document.documentElement;
    const visualViewport = window.visualViewport;
    const clearRecoveryTimers = () => {
      for (const timer of recoveryTimersRef.current) window.clearTimeout(timer);
      recoveryTimersRef.current = [];
    };
    const setHeight = (height: number) => {
      root.style.setProperty("--app-viewport-height", `${Math.max(1, Math.round(height))}px`);
    };
    const update = () => {
      const height = visualViewport?.height ?? window.innerHeight;
      setHeight(height);
    };
    const restoreAfterKeyboard = () => {
      clearRecoveryTimers();
      update();
      recoveryTimersRef.current = KEYBOARD_RECOVERY_DELAYS_MS.map((delay) =>
        window.setTimeout(() => {
          const activeElement = document.activeElement;
          if (
            activeElement instanceof HTMLInputElement ||
            activeElement instanceof HTMLSelectElement ||
            activeElement instanceof HTMLTextAreaElement ||
            activeElement?.getAttribute("contenteditable") === "true"
          ) {
            update();
            return;
          }

          // iOS can deliver the focus/viewport events before the visual
          // viewport has expanded again. Once no text field owns focus, the
          // layout viewport is the safe recovery floor for the app surface.
          setHeight(Math.max(window.innerHeight, document.documentElement.clientHeight, visualViewport?.height ?? 0));
        }, delay),
      );
    };
    const handleFocusOut = () => restoreAfterKeyboard();

    update();
    window.addEventListener("resize", update);
    visualViewport?.addEventListener("resize", update);
    visualViewport?.addEventListener("scroll", update);
    document.addEventListener("focusout", handleFocusOut, true);

    return () => {
      clearRecoveryTimers();
      window.removeEventListener("resize", update);
      visualViewport?.removeEventListener("resize", update);
      visualViewport?.removeEventListener("scroll", update);
      document.removeEventListener("focusout", handleFocusOut, true);
      root.style.removeProperty("--app-viewport-height");
    };
  }, []);
}
