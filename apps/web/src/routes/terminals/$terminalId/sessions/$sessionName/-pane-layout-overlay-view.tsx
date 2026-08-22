import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { PaneSummary } from "@muximo/contract";
import { AppIcon } from "../../../../../app/components/app-icon";
import { paneStateLabel } from "./-pane-state";

export type PaneLayoutOverlayVariant = "ghost";

export function PaneLayoutOverlay({
  id,
  panes,
  selectedTarget,
  onSelect,
  onClose,
  variant = "ghost",
}: {
  id?: string;
  panes: PaneSummary[];
  selectedTarget: string;
  onSelect: (pane: PaneSummary) => void;
  onClose?: () => void;
  variant?: PaneLayoutOverlayVariant;
}) {
  const windows = useMemo(() => groupByWindow(panes), [panes]);
  const selectedPane = panes.find((pane) => pane.tmuxPaneId === selectedTarget);
  const [activeWindowId, setActiveWindowId] = useState(selectedPane?.windowId ?? windows[0]?.id ?? "");
  const overlayRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const activeWindow = windows.find((window) => window.id === activeWindowId) ?? windows[0];
  const activeSessionPaneCount = activeWindow
    ? panes.filter((pane) => pane.sessionName === activeWindow.sessionName).length
    : 0;
  const useCompactPaneList = activeWindow
    ? activeWindow.hasGeometry && paneLayoutNeedsCompactTargets(activeWindow.panes, activeWindow.windowWidth, activeWindow.windowHeight)
    : false;
  const ghost = variant === "ghost";
  const paneGridClass = useCompactPaneList
    ? "grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))] content-stretch overflow-auto"
    : activeWindow?.hasGeometry
      ? "relative block min-h-0 overflow-hidden bg-terminal-grid bg-[length:100%_16px]"
      : activeWindow?.panes.length === 1
        ? "grid-cols-[minmax(0,1fr)]"
          : activeWindow?.panes.length === 2
            ? "grid-cols-2"
            : "grid-cols-2 [&>button:first-child]:row-span-2";
  const overlayVariantClass = ghost
    ? "gap-2 rounded-none border-0 bg-[rgb(0_3_1_/_20%)] p-2.5 shadow-none backdrop-blur-[2px] max-[920px]:p-[calc(12px+var(--safe-area-top))_max(12px,var(--safe-area-right))_calc(12px+var(--safe-area-bottom))_max(12px,var(--safe-area-left))] max-[620px]:pt-[calc(8px+var(--safe-area-top))] max-[620px]:px-2"
    : "";
  const headingVariantClass = ghost ? "px-[3px] opacity-80" : "";
  const headingCopyVariantClass = ghost ? "gap-1" : "";
  const windowTabsVariantClass = ghost ? "px-[3px] pb-[3px]" : "";
  const panelVariantClass = ghost ? "mx-[3px] rounded-[3px] border-0 bg-transparent shadow-none" : "";
  const footerVariantClass = ghost ? "px-[3px] opacity-70 [text-shadow:0_1px_8px_#000]" : "";

  useEffect(() => {
    if (selectedPane && selectedPane.windowId !== activeWindowId) setActiveWindowId(selectedPane.windowId);
  }, [activeWindowId, selectedPane]);

  useEffect(() => {
    if (!onClose) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onPointerDownOutside = (event: PointerEvent) => {
      const overlay = overlayRef.current;
      if (!overlay) return;
      const target = event.target;
      if (target instanceof Node && overlay.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(overlayRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
        .filter((element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) return;
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
        : (currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
      event.preventDefault();
      focusable[nextIndex]?.focus();
    };
    document.addEventListener("pointerdown", onPointerDownOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("pointerdown", onPointerDownOutside);
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [onClose]);

  return (
    <section ref={overlayRef} id={id} className={`relative flex h-full min-h-0 w-full flex-col gap-3 overflow-hidden rounded-[15px] border border-[rgb(139_255_154_/_24%)] bg-[rgb(2_8_4_/_78%)] p-[18px] text-ink shadow-[0_24px_80px_rgb(0_0_0_/_52%),inset_0_0_0_1px_rgb(139_255_154_/_4%)] backdrop-blur-[20px] max-[920px]:rounded-xl max-[620px]:gap-2 max-[620px]:rounded-[10px] max-[620px]:p-3 ${overlayVariantClass}`} role={onClose ? "dialog" : "region"} aria-modal={onClose ? true : undefined} aria-label="tmux window layout" tabIndex={onClose ? -1 : undefined} onPointerDown={onClose ? (event) => { if (isOverlayBackdropTarget(event.target, event.currentTarget)) onClose(); } : undefined}>
      <div className={`flex min-w-0 items-center justify-between gap-3 ${headingVariantClass}`}>
        <div className={`flex min-w-0 flex-col items-start gap-[7px] ${headingCopyVariantClass}`}>
          <span className="flex items-center gap-[7px] font-mono text-[0.62rem] font-bold leading-none tracking-[0.13em] text-muted"><span className="size-1.5 rounded-full bg-lime-deep shadow-[0_0_0_3px_rgb(97_143_55_/_12%)]" /> WINDOW MAP</span>
          <strong className={`overflow-hidden font-mono text-[0.72rem] font-semibold text-ellipsis whitespace-nowrap text-[#dcffe0] ${ghost ? "text-[0.64rem] text-[#c4f3c9] [text-shadow:0_1px_8px_#000]" : ""}`}>{activeWindow ? `${activeWindow.sessionName} · ${activeWindow.name || `window ${activeWindow.index}`}` : "No tmux window"}</strong>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[0.52rem] text-[#4b7c54] max-[620px]:text-[0.47rem]">{windows.length} windows · {activeSessionPaneCount} panes</span>
          {onClose ? <button ref={closeButtonRef} className="grid size-7 place-items-center rounded-lg border border-[#26552f] bg-[#0b2110] text-base leading-none text-[#9acba1] transition-colors hover:border-lime-deep hover:text-lime max-[620px]:size-[25px] max-[620px]:text-[0.85rem]" type="button" onClick={onClose} aria-label="Close window map"><AppIcon name="close" size={16} /></button> : null}
        </div>
      </div>

      <div className={`flex min-w-0 gap-[5px] overflow-x-auto p-0.5 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [scrollbar-gutter:stable] ${windowTabsVariantClass}`} role="tablist" aria-label="tmux windows">
        {windows.map((window) => {
          const attention = window.panes.some((pane) => pane.state === "waiting_input" || pane.state === "waiting_approval");
          const selected = window.id === activeWindow?.id;
          const windowSelectionClass = selected ? "border-[#347243] bg-[#12331a] text-[#d8ffdc] shadow-[inset_0_-2px_0_var(--color-lime-deep)]" : "border-transparent bg-[rgb(7_21_10_/_64%)]";
          const windowGhostClass = ghost
            ? `border-[rgb(139_255_154_/_42%)] bg-[rgb(3_14_6_/_32%)] shadow-none backdrop-blur-[3px] ${selected ? "border-[rgb(139_255_154_/_46%)] bg-[rgb(57_214_91_/_24%)] shadow-[inset_0_-1px_0_var(--color-lime-deep)]" : ""}`
            : "";
          return (
            <button
              className={`flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-[9px] py-[7px] font-mono text-[0.56rem] text-[#6c9a75] transition-colors hover:border-[#347243] hover:bg-[#12331a] hover:text-[#d8ffdc] max-[620px]:px-[7px] max-[620px]:py-1.5 max-[620px]:text-[0.5rem] ${windowSelectionClass} ${windowGhostClass}`}
              key={window.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveWindowId(window.id)}
            >
              <span className={`size-[5px] shrink-0 rounded-full ${attention ? "bg-amber shadow-[0_0_0_3px_rgb(241_199_109_/_12%)]" : "bg-[#42774c]"}`} />
              <span className="max-w-[120px] overflow-hidden text-ellipsis max-[620px]:max-w-[88px]">{window.sessionName}</span>
              <span className="text-[#416c49]">{window.index}</span>
            </button>
          );
        })}
      </div>

      {activeWindow ? (
        <div className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-[11px] border border-[#2b6036] bg-[rgb(1_6_3_/_86%)] shadow-[inset_0_0_30px_rgb(57_214_91_/_5%)] ${panelVariantClass}`} role="tabpanel" aria-label={`${activeWindow.sessionName} window ${activeWindow.index}`}>
          <div className={`flex min-h-[30px] items-center justify-between gap-2.5 border-b border-[#1d4426] px-2.5 font-mono text-[0.53rem] text-[#5d9168] max-[620px]:min-h-[26px] max-[620px]:px-2 max-[620px]:text-[0.47rem] ${ghost ? "hidden" : ""}`}>
            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[#9fd5a6]">{activeWindow.sessionName}</span>
            <span>window {activeWindow.index}</span>
            <span>{activeWindow.panes.length} panes in window</span>
          </div>
        <div className={`grid min-h-0 flex-1 gap-1 p-1 max-[620px]:gap-[3px] max-[620px]:p-[3px] ${paneGridClass} ${ghost ? "gap-0 p-0" : ""}`}>
            {activeWindow.panes.map((pane) => {
              const waiting = pane.state === "waiting_input" || pane.state === "waiting_approval";
              const statusClass = waiting ? "text-amber" : pane.state === "failed" ? "text-[#f07e7e]" : "text-[#8fcf98]";
              const statusDotClass = waiting ? "bg-amber shadow-[0_0_0_3px_rgb(241_199_109_/_12%)]" : pane.state === "failed" ? "bg-[#f07e7e]" : "bg-lime-deep";
              return (
              <button
                className={`flex min-w-0 min-h-[72px] flex-col items-start justify-end overflow-hidden rounded-[7px] border border-[#1b4526] bg-pane-grid bg-[#071409] bg-[length:100%_16px] p-[9px] text-left text-[#89bd91] transition-[border-color,background,box-shadow] hover:border-lime-deep hover:bg-[#0b2511] hover:text-[#e0ffe3] hover:shadow-[inset_3px_0_0_var(--color-lime),0_0_18px_rgb(57_214_91_/_13%)] max-[620px]:min-h-[62px] max-[620px]:p-[7px] ${activeWindow.hasGeometry && !useCompactPaneList ? "absolute min-h-0 rounded-none" : useCompactPaneList ? "relative min-h-14" : ""} ${pane.tmuxPaneId === selectedTarget ? "border-lime-deep bg-[#0b2511] text-[#e0ffe3] shadow-[inset_3px_0_0_var(--color-lime),0_0_18px_rgb(57_214_91_/_13%)]" : ""} ${ghost ? "min-h-0 justify-end rounded-[3px] border-[rgb(139_255_154_/_42%)] bg-[rgb(3_14_6_/_18%)] p-[9px] shadow-[inset_0_0_0_1px_rgb(0_0_0_/_14%)] backdrop-blur-[1px] [text-shadow:0_1px_8px_#000] hover:bg-[rgb(57_214_91_/_31%)]" : ""}`}
                key={pane.id}
                type="button"
                onClick={() => onSelect(pane)}
                aria-label={`Select pane ${pane.paneIndex ?? "unknown"}: ${pane.name}`}
                title={pane.recentOutput ? `${pane.tmuxPaneId}\n${pane.recentOutput}` : pane.tmuxPaneId}
                style={activeWindow.hasGeometry && !useCompactPaneList ? paneGeometryStyle(pane, activeWindow) : undefined}
              >
                <span className="font-mono text-[0.52rem] text-lime max-[620px]:text-[0.45rem]">PANE {pane.paneIndex ?? "?"}</span>
                <strong className="mt-1 block max-w-full overflow-hidden text-[0.64rem] font-bold text-[#d8ffdc] text-ellipsis whitespace-nowrap max-[620px]:text-[0.54rem]">{pane.name}</strong>
                <small className={`mt-1 flex max-w-full items-center gap-1 overflow-hidden font-mono text-[0.52rem] text-ellipsis whitespace-nowrap max-[620px]:text-[0.45rem] ${statusClass}`}><span className={`size-[5px] shrink-0 rounded-full ${statusDotClass}`} />{pane.agentId ?? "zsh"} · {paneStateLabel(pane.state)}</small>
                {pane.recentOutput ? <span className="mt-[5px] max-w-full overflow-hidden font-mono text-[0.48rem] leading-[1.35] text-[#87b78e] whitespace-pre-line [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] max-[620px]:text-[0.45rem]">{pane.recentOutput}</span> : null}
              </button>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="m-0 text-[0.7rem] text-muted">No tmux windows found.</p>
      )}

      <div className={`flex items-center justify-between gap-2.5 font-mono text-[0.52rem] text-[#4b7c54] ${footerVariantClass}`}>
        <span>tap a pane to open</span>
        <span>⌁ live tmux layout</span>
      </div>
    </section>
  );
}

export function isOverlayBackdropTarget(target: unknown, currentTarget: unknown): boolean {
  return target !== null && target === currentTarget;
}

const FOCUSABLE_SELECTOR = "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])";

function groupByWindow(panes: PaneSummary[]): Array<{
  id: string;
  sessionName: string;
  name: string;
  index: number;
  windowWidth?: number;
  windowHeight?: number;
  hasGeometry: boolean;
  panes: PaneSummary[];
}> {
  const windows = new Map<string, {
    id: string;
    sessionName: string;
    name: string;
    index: number;
    windowWidth?: number;
    windowHeight?: number;
    hasGeometry: boolean;
    panes: PaneSummary[];
    windowWidths: number[];
    windowHeights: number[];
  }>();
  for (const pane of panes) {
    const current = windows.get(pane.windowId) ?? {
      id: pane.windowId,
      sessionName: pane.sessionName,
      name: pane.windowName ?? "",
      index: pane.windowIndex ?? (Number(windowIdNumber(pane.windowId)) || 0),
      windowWidth: pane.windowWidth,
      windowHeight: pane.windowHeight,
      hasGeometry: true,
      panes: [],
      windowWidths: [],
      windowHeights: [],
    };
    current.hasGeometry = current.hasGeometry && hasPaneGeometry(pane);
    if (typeof pane.windowWidth === "number" && pane.windowWidth > 0) current.windowWidths.push(pane.windowWidth);
    if (typeof pane.windowHeight === "number" && pane.windowHeight > 0) current.windowHeights.push(pane.windowHeight);
    current.panes.push(pane);
    windows.set(pane.windowId, current);
  }
  return [...windows.values()].map(({ windowWidths, windowHeights, ...rest }) => {
    const consensusWidth = consensusWindowDimension(windowWidths);
    const consensusHeight = consensusWindowDimension(windowHeights);
    // If window dimensions are inconsistent across panes (stale snapshot during
    // viewport resize), prefer the consensus value and mark geometry as
    // unavailable when no consensus exists. This prevents absolute panes from
    // being rendered with a mismatched 200%-wide window that looks translucent.
    const windowWidth = consensusWidth ?? rest.windowWidth;
    const windowHeight = consensusHeight ?? rest.windowHeight;
    const validWindow = typeof windowWidth === "number" && typeof windowHeight === "number"
      && windowWidth >= 20 && windowWidth <= 500
      && windowHeight >= 5 && windowHeight <= 300;
    return {
      ...rest,
      windowWidth,
      windowHeight,
      hasGeometry: rest.hasGeometry && validWindow,
    };
  });
}

function consensusWindowDimension(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: number | undefined;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && (best === undefined || value > best))) {
      best = value;
      bestCount = count;
    }
  }
  // Require at least half the panes to agree; otherwise the window was
  // resized between pane listings and no dimension is trustworthy.
  if (best !== undefined && bestCount * 2 < values.length) return undefined;
  return best;
}

function windowIdNumber(id: string): string {
  return id.replace(/^@/, "");
}

export function hasPaneGeometry(pane: Pick<PaneSummary, "left" | "top" | "width" | "height" | "windowWidth" | "windowHeight">): boolean {
  if (![pane.left, pane.top].every((value) => typeof value === "number" && value >= 0)) return false;
  if (![pane.width, pane.height, pane.windowWidth, pane.windowHeight].every((value) => typeof value === "number" && value > 0)) return false;
  // Pane must fit inside the window; a wider pane indicates a stale window
  // size (mobile/desktop viewport race) and should fall back to grid layout.
  if (typeof pane.width === "number" && typeof pane.windowWidth === "number" && pane.width > pane.windowWidth) return false;
  if (typeof pane.height === "number" && typeof pane.windowHeight === "number" && pane.height > pane.windowHeight) return false;
  if (typeof pane.windowWidth === "number" && (pane.windowWidth < 20 || pane.windowWidth > 500)) return false;
  if (typeof pane.windowHeight === "number" && (pane.windowHeight < 5 || pane.windowHeight > 300)) return false;
  return true;
}

export const MIN_TOUCH_PANE_WIDTH_RATIO = 0.16;
export const MIN_TOUCH_PANE_HEIGHT_RATIO = 0.25;

export function paneLayoutNeedsCompactTargets(
  panes: Array<Pick<PaneSummary, "left" | "top" | "width" | "height" | "windowWidth" | "windowHeight">>,
  windowWidth?: number,
  windowHeight?: number,
): boolean {
  if (!windowWidth || !windowHeight || windowWidth <= 0 || windowHeight <= 0) return false;
  return panes.some((pane) => {
    if (!hasPaneGeometry(pane)) return false;
    return pane.width! / windowWidth < MIN_TOUCH_PANE_WIDTH_RATIO
      || pane.height! / windowHeight < MIN_TOUCH_PANE_HEIGHT_RATIO;
  });
}

function paneGeometryStyle(
  pane: PaneSummary,
  window: { windowWidth?: number; windowHeight?: number },
): CSSProperties | undefined {
  if (!hasPaneGeometry(pane) || !window.windowWidth || !window.windowHeight) return undefined;
  const clamp = (value: number) => Math.max(0, Math.min(100, value));
  const left = clamp((pane.left! / window.windowWidth) * 100);
  const top = clamp((pane.top! / window.windowHeight) * 100);
  const width = clamp((pane.width! / window.windowWidth) * 100);
  const height = clamp((pane.height! / window.windowHeight) * 100);
  // Prevent panes from overflowing the window due to rounding errors.
  return {
    left: `${left}%`,
    top: `${top}%`,
    width: `${Math.min(width, 100 - left)}%`,
    height: `${Math.min(height, 100 - top)}%`,
  };
}
