import type { PaneSummary } from "@muximo/contract/api";
import type { CSSProperties } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { AppIcon } from "../../../../../app/components/app-icon";
import { buildPaneWindows, hasPaneGeometry, paneWindowId } from "./-pane-layout-policy";
import { paneStateLabel } from "./-pane-state";

export function PaneLayoutOverlay({
  id,
  panes,
  selectedTarget,
  onSelect,
  onClose,
  onCreatePane,
}: {
  id?: string;
  panes: PaneSummary[];
  selectedTarget: string;
  onSelect: (pane: PaneSummary) => void;
  onClose?: () => void;
  onCreatePane?: () => void;
}) {
  const windows = useMemo(() => buildPaneWindows(panes), [panes]);
  const selectedPane = panes.find((pane) => pane.hostPaneId === selectedTarget);
  const selectedWindowId = selectedPane ? paneWindowId(selectedPane) : undefined;
  const [activeWindowId, setActiveWindowId] = useState(() => selectedWindowId ?? windows[0]?.id ?? "");
  const overlayRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const onCloseRef = useRef(onClose);
  const activeWindow = windows.find((window) => window.id === activeWindowId) ?? windows[0];
  const activeSessionPaneCount = activeWindow
    ? windows
        .filter((window) => window.sessionName === activeWindow.sessionName)
        .reduce((count, window) => count + window.panes.length, 0)
    : 0;
  const isGeometricLayout = Boolean(activeWindow?.hasGeometry);
  const paneAreaClass = "relative min-h-0 flex-1 overflow-hidden bg-terminal-grid bg-[length:100%_16px]";

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (selectedWindowId) setActiveWindowId(selectedWindowId);
  }, [selectedWindowId]);

  useEffect(() => {
    setActiveWindowId((current) => {
      if (current && windows.some((window) => window.id === current)) return current;
      return selectedWindowId ?? windows[0]?.id ?? "";
    });
  }, [selectedWindowId, windows]);

  const isModal = Boolean(onClose);
  useEffect(() => {
    if (!isModal) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current?.();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(overlayRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])].filter(
        (element) => !element.hasAttribute("disabled") && element.getAttribute("aria-hidden") !== "true",
      );
      if (!focusable.length) return;
      const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? focusable.length - 1
          : currentIndex - 1
        : currentIndex === focusable.length - 1
          ? 0
          : currentIndex + 1;
      event.preventDefault();
      focusable[nextIndex]?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus({ preventScroll: true });
    };
  }, [isModal]);

  const overlayRole = isModal ? "dialog" : "region";
  const panelId = `${id ?? "tmux-window-layout"}-panel`;

  return (
    <section
      ref={overlayRef}
      id={id}
      className="relative flex h-full min-h-0 w-full flex-col gap-3 overflow-hidden rounded-[15px] border border-[#2b6036] bg-[#071108] p-[18px] text-ink shadow-[0_24px_80px_rgb(0_0_0_/_52%),inset_0_0_0_1px_rgb(139_255_154_/_4%)] max-[920px]:rounded-xl max-[620px]:gap-2 max-[620px]:rounded-[10px] max-[620px]:p-3"
      role={overlayRole}
      aria-modal={isModal ? true : undefined}
      aria-label="tmux window layout"
      tabIndex={isModal ? -1 : undefined}
    >
      <div className="flex min-w-0 shrink-0 items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col items-start gap-[7px]">
          <span className="flex items-center gap-[7px] font-mono text-[0.62rem] font-bold leading-none tracking-[0.13em] text-muted">
            <span className="size-1.5 rounded-full bg-lime-deep shadow-[0_0_0_3px_rgb(97_143_55_/_12%)]" /> WINDOW MAP
          </span>
          <strong className="overflow-hidden font-mono text-[0.72rem] font-semibold text-ellipsis whitespace-nowrap text-[#dcffe0]">
            {activeWindow
              ? `${activeWindow.sessionName} · ${activeWindow.name || `window ${activeWindow.index}`}`
              : "No tmux window"}
          </strong>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[0.52rem] text-[#4b7c54] max-[620px]:text-[0.47rem]">
            {windows.length} windows · {activeSessionPaneCount} panes
          </span>
          {onCreatePane ? (
            <button
              className="rounded-[7px] border border-[#315f3a] bg-[#0b2110] px-2 py-1.5 font-mono text-[0.52rem] text-[#9acba1] transition-colors hover:border-lime-deep hover:text-lime"
              type="button"
              onClick={onCreatePane}
            >
              + pane
            </button>
          ) : null}
          {onClose ? (
            <button
              ref={closeButtonRef}
              className="grid size-7 place-items-center rounded-lg border border-[#26552f] bg-[#0b2110] text-base leading-none text-[#9acba1] transition-colors hover:border-lime-deep hover:text-lime max-[620px]:size-[25px] max-[620px]:text-[0.85rem]"
              type="button"
              onClick={onClose}
              aria-label="Close window map"
            >
              <AppIcon name="close" size={16} />
            </button>
          ) : null}
        </div>
      </div>

      <div
        className="flex min-w-0 shrink-0 gap-[5px] overflow-x-auto p-0.5 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [scrollbar-gutter:stable]"
        role="tablist"
        aria-label="tmux windows"
      >
        {windows.map((window) => {
          const attention = window.panes.some(
            (pane) => pane.state === "waiting_input" || pane.state === "waiting_approval",
          );
          const selected = window.id === activeWindow?.id;
          const windowSelectionClass = selected
            ? "border-[#347243] bg-[#12331a] text-[#d8ffdc] shadow-[inset_0_-2px_0_var(--color-lime-deep)]"
            : "border-transparent bg-[#07150a] text-[#6c9a75]";
          return (
            <button
              className={`flex min-w-0 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[7px] border px-[9px] py-[7px] font-mono text-[0.56rem] transition-colors hover:border-[#347243] hover:bg-[#12331a] hover:text-[#d8ffdc] max-[620px]:px-[7px] max-[620px]:py-1.5 max-[620px]:text-[0.5rem] ${windowSelectionClass}`}
              key={window.id}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveWindowId(window.id)}
            >
              <span
                className={`size-[5px] shrink-0 rounded-full ${attention ? "bg-amber shadow-[0_0_0_3px_rgb(241_199_109_/_12%)]" : "bg-[#42774c]"}`}
              />
              <span className="max-w-[120px] overflow-hidden text-ellipsis max-[620px]:max-w-[88px]">
                {window.sessionName}
              </span>
              <span className="text-[#416c49]">{window.index}</span>
            </button>
          );
        })}
      </div>

      {activeWindow ? (
        <div
          id={panelId}
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-[11px] border border-[#2b6036] bg-[#020503] shadow-[inset_0_0_30px_rgb(57_214_91_/_5%)]"
          role="tabpanel"
          aria-label={`${activeWindow.sessionName} window ${activeWindow.index}`}
        >
          <div className="flex min-h-[30px] shrink-0 items-center justify-between gap-2.5 border-b border-[#1d4426] px-2.5 font-mono text-[0.53rem] text-[#5d9168] max-[620px]:min-h-[26px] max-[620px]:px-2 max-[620px]:text-[0.47rem]">
            <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[#9fd5a6]">
              {activeWindow.sessionName}
            </span>
            <span>window {activeWindow.index}</span>
            <span>{activeWindow.panes.length} panes in window</span>
          </div>
          <div className={paneAreaClass}>
            {isGeometricLayout ? (
              activeWindow.panes.map((pane) => {
                const waiting = pane.state === "waiting_input" || pane.state === "waiting_approval";
                const selected = pane.hostPaneId === selectedTarget;
                const statusClass = waiting
                  ? "text-amber"
                  : pane.state === "failed"
                    ? "text-[#f07e7e]"
                    : "text-[#8fcf98]";
                const statusDotClass = waiting
                  ? "bg-amber shadow-[0_0_0_3px_rgb(241_199_109_/_12%)]"
                  : pane.state === "failed"
                    ? "bg-[#f07e7e]"
                    : "bg-lime-deep";
                const paneButtonLayoutClass = "absolute min-h-0";
                const paneButtonShapeClass = "rounded-none";
                const paneButtonSurfaceClass = selected
                  ? "border-lime-deep bg-[#0b2511] text-[#e0ffe3] shadow-[inset_3px_0_0_var(--color-lime),0_0_18px_rgb(57_214_91_/_13%)]"
                  : "border-[#1b4526] bg-[#071409] text-[#89bd91]";
                const paneButtonInteractionClass =
                  "hover:border-lime-deep hover:bg-[#0b2511] hover:text-[#e0ffe3] hover:shadow-[inset_3px_0_0_var(--color-lime),0_0_18px_rgb(57_214_91_/_13%)]";
                const paneButtonSpacingClass = "p-[9px] max-[620px]:p-[7px]";
                return (
                  <button
                    className={`flex w-full min-w-0 flex-col items-start justify-end overflow-hidden border bg-pane-grid bg-[length:100%_16px] text-left transition-[border-color,background,box-shadow] ${paneButtonLayoutClass} ${paneButtonShapeClass} ${paneButtonSurfaceClass} ${paneButtonInteractionClass} ${paneButtonSpacingClass}`}
                    key={pane.id}
                    type="button"
                    onClick={() => onSelect(pane)}
                    aria-label={`Select pane ${pane.paneIndex ?? "unknown"}: ${pane.name}`}
                    title={pane.recentOutput ? `${pane.hostPaneId}\n${pane.recentOutput}` : pane.hostPaneId}
                    style={paneGeometryStyle(pane, activeWindow)}
                  >
                    <span className="font-mono text-[0.52rem] text-lime max-[620px]:text-[0.45rem]">
                      PANE {pane.paneIndex ?? "?"}
                    </span>
                    <strong className="mt-1 block max-w-full overflow-hidden text-[0.64rem] font-bold text-[#d8ffdc] text-ellipsis whitespace-nowrap max-[620px]:text-[0.54rem]">
                      {pane.name}
                    </strong>
                    <small
                      className={`mt-1 flex max-w-full items-center gap-1 overflow-hidden font-mono text-[0.52rem] text-ellipsis whitespace-nowrap max-[620px]:text-[0.45rem] ${statusClass}`}
                    >
                      <span className={`size-[5px] shrink-0 rounded-full ${statusDotClass}`} />
                      {pane.agentId ?? "zsh"} · {paneStateLabel(pane.state)}
                    </small>
                    {pane.recentOutput ? (
                      <span className="mt-[5px] max-w-full overflow-hidden font-mono text-[0.48rem] leading-[1.35] text-[#87b78e] whitespace-pre-line [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] max-[620px]:text-[0.45rem]">
                        {pane.recentOutput}
                      </span>
                    ) : null}
                  </button>
                );
              })
            ) : (
              <p className="m-auto px-5 text-center font-mono text-[0.68rem] text-[#6d9d75]" role="status">
                Reading a complete tmux layout…
              </p>
            )}
          </div>
        </div>
      ) : (
        <p className="m-0 text-[0.7rem] text-muted">No tmux windows found.</p>
      )}

      <div className="flex shrink-0 items-center justify-between gap-2.5 font-mono text-[0.52rem] text-[#4b7c54]">
        <span>tap a pane to open</span>
        <span>⌁ live tmux layout</span>
      </div>
    </section>
  );
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function paneGeometryStyle(
  pane: PaneSummary,
  window: { windowWidth?: number; windowHeight?: number },
): CSSProperties | undefined {
  const { windowWidth, windowHeight } = window;
  if (!isPositiveInteger(windowWidth) || !isPositiveInteger(windowHeight)) return undefined;
  if (
    !hasPaneGeometry(pane) ||
    pane.windowWidth !== windowWidth ||
    pane.windowHeight !== windowHeight ||
    pane.left + pane.width > windowWidth ||
    pane.top + pane.height > windowHeight
  ) {
    return undefined;
  }
  const clamp = (value: number) => Math.max(0, Math.min(100, value));
  const left = clamp((pane.left / windowWidth) * 100);
  const top = clamp((pane.top / windowHeight) * 100);
  const width = clamp((pane.width / windowWidth) * 100);
  const height = clamp((pane.height / windowHeight) * 100);
  return {
    left: `${left}%`,
    top: `${top}%`,
    width: `${Math.min(width, 100 - left)}%`,
    height: `${Math.min(height, 100 - top)}%`,
  };
}

function isPositiveInteger(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value > 0;
}
