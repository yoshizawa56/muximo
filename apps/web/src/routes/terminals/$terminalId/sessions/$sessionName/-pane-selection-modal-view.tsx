import type { PaneSummary } from "@muximo/contract/api";
import { useRef } from "react";
import { AppIcon } from "../../../../../app/components/app-icon";
import { AppSafeAreaOverlay } from "../../../../../app/components/app-layout";
import { PaneLayoutOverlay } from "./-pane-layout-overlay-view";

export type PaneSelectionModalStatus = "loading" | "ready" | "error";

export function PaneSelectionModal({
  panes,
  selectedTarget,
  status,
  errorMessage,
  onSelect,
  onClose,
  onRefresh,
  onCreatePane,
}: {
  panes: PaneSummary[];
  selectedTarget: string;
  status: PaneSelectionModalStatus;
  errorMessage: string | null;
  onSelect: (pane: PaneSummary) => void;
  onClose: () => void;
  onRefresh: () => void;
  onCreatePane?: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);

  return (
    <AppSafeAreaOverlay
      className="z-40 bg-[#020503] pointer-events-auto"
      onPointerDown={(event) => {
        if (isOutsideModalTarget(event.target, modalRef.current)) onClose();
      }}
    >
      <div className="flex h-full min-h-0 w-full items-center justify-center p-4">
        <div ref={modalRef} className="h-full min-h-0 w-full max-w-[960px]">
          {status === "ready" ? (
            <PaneLayoutOverlay
              id="tmux-window-map"
              panes={panes}
              selectedTarget={selectedTarget}
              onSelect={onSelect}
              onClose={onClose}
              onCreatePane={onCreatePane}
            />
          ) : (
            <section
              className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[15px] border border-[#2b6036] bg-[#071108] text-ink shadow-[0_24px_80px_rgb(0_0_0_/_52%)] max-[620px]:rounded-[10px]"
              role="dialog"
              aria-modal="true"
              aria-label="Select tmux pane"
              onKeyDown={(event) => {
                if (event.key === "Escape") onClose();
              }}
            >
              <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#1d4426] px-[18px] py-3 max-[620px]:px-3">
                <div className="min-w-0">
                  <span className="font-mono text-[0.62rem] font-bold tracking-[0.13em] text-lime-deep">
                    WINDOW MAP
                  </span>
                  <h2 className="m-0 mt-1 overflow-hidden text-[0.9rem] font-semibold text-ellipsis whitespace-nowrap text-[#dcffe0]">
                    Select a pane
                  </h2>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {onCreatePane ? (
                    <button
                      className="rounded-[7px] border border-[#315f3a] bg-[#0b2110] px-2 py-1.5 font-mono text-[0.52rem] text-[#9acba1] transition-colors hover:border-lime-deep hover:text-lime"
                      type="button"
                      onClick={onCreatePane}
                    >
                      + pane
                    </button>
                  ) : null}
                  <button
                    className="grid size-8 shrink-0 place-items-center rounded-[7px] border border-[#315f3a] bg-[#0b2110] text-[#9acba1] transition-colors hover:border-lime-deep hover:text-lime"
                    type="button"
                    onClick={onClose}
                    aria-label="Close pane selection"
                  >
                    <AppIcon name="close" size={16} />
                  </button>
                </div>
              </header>
              <div className="grid min-h-0 flex-1 place-items-center p-5 text-center">
                {status === "loading" ? (
                  <p className="font-mono text-[0.68rem] text-[#6d9d75]" role="status">
                    Reading tmux layout…
                  </p>
                ) : (
                  <div className="flex max-w-[360px] flex-col items-center gap-3" role="alert">
                    <p className="m-0 font-mono text-[0.68rem] text-[#a45d51]">{errorMessage}</p>
                    <button
                      className="rounded-[7px] border border-[#315f3a] bg-[#0b2110] px-3 py-2 font-mono text-[0.62rem] text-[#9acba1] transition-colors hover:border-lime-deep hover:text-lime"
                      type="button"
                      onClick={onRefresh}
                    >
                      Try again
                    </button>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </AppSafeAreaOverlay>
  );
}

type ContainmentElement = { contains(target: unknown): boolean };

export function isOutsideModalTarget(target: unknown, modal: ContainmentElement | null): boolean {
  return target !== null && modal !== null && !modal.contains(target);
}
