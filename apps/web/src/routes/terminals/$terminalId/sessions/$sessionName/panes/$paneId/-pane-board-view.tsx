import { AppIcon } from "../../../../../../../app/components/app-icon";
import { PaneLayoutOverlay, type PaneLayoutOverlayVariant } from "../../-pane-layout-overlay-view";
import { paneStateLabel } from "../../-pane-state";
import type { PaneBoardViewModel } from "./-pane-board-viewmodel";

export function PaneBoardView({
  viewModel,
  alwaysOpen = false,
  showLayout = false,
  layoutVariant = "ghost",
}: {
  viewModel: PaneBoardViewModel;
  alwaysOpen?: boolean;
  showLayout?: boolean;
  layoutVariant?: PaneLayoutOverlayVariant;
}) {
  const waitingCount = viewModel.panes.filter(
    (pane) => pane.state === "waiting_input" || pane.state === "waiting_approval",
  ).length;
  const mobileBoardClass = alwaysOpen
    ? showLayout
      ? "max-[920px]:fixed max-[920px]:inset-0 max-[920px]:z-[21] max-[920px]:flex max-[920px]:min-h-0 max-[920px]:border-0 max-[920px]:bg-transparent max-[920px]:p-0 max-[920px]:shadow-none max-[920px]:pointer-events-auto"
      : "max-[920px]:fixed max-[920px]:inset-[64px_12px_12px] max-[920px]:z-10 max-[920px]:hidden max-[920px]:bg-paper max-[920px]:shadow-[0_24px_70px_rgb(30_36_31_/_24%)] data-[open=true]:max-[920px]:flex"
    : "";

  return (
    <div className="relative min-h-0">
      <aside
        className={`flex min-h-[480px] flex-col rounded-[15px] border border-line bg-[rgb(248_248_244_/_82%)] p-[18px] text-[#303631] shadow-[0_18px_42px_rgb(39_46_38_/_6%)] max-[1180px]:p-3.5 max-[920px]:min-h-0 ${mobileBoardClass} ${showLayout ? "relative min-h-0 overflow-hidden border-transparent bg-transparent p-0 shadow-none" : ""}`}
        data-open={viewModel.isOpen}
        aria-label="tmux panes"
      >
        {showLayout ? (
          <PaneLayoutOverlay
            id="tmux-window-map"
            panes={viewModel.panes}
            selectedTarget={viewModel.selectedTarget}
            onSelect={viewModel.select}
            onClose={viewModel.close}
            variant={layoutVariant}
          />
        ) : null}
        {!showLayout ? (
          <>
            <div className="flex items-center justify-between gap-2.5">
              <div>
                <div className="flex items-center gap-[7px] font-mono text-[0.62rem] font-bold leading-none tracking-[0.13em] text-muted">
                  <span className="size-1.5 rounded-full bg-lime-deep shadow-[0_0_0_3px_rgb(97_143_55_/_12%)]" />{" "}
                  WORKSPACE
                </div>
                <h2 className="mt-[9px] text-base font-bold tracking-[-0.04em] text-ink">Command deck</h2>
              </div>
              <div className="flex items-center gap-1.5 self-start">
                <span className="mr-0.5 font-mono text-[0.57rem] text-[#8d672e]">
                  {waitingCount ? `${waitingCount} needs you` : "All clear"}
                </span>
                <button
                  className="grid size-[27px] place-items-center rounded-lg border border-line bg-transparent text-[0.8rem] text-muted transition-colors hover:border-line-strong hover:bg-paper hover:text-ink"
                  type="button"
                  onClick={viewModel.refresh}
                  aria-label="Refresh panes"
                  title="Refresh panes"
                >
                  <AppIcon name="refresh" size={15} />
                </button>
                <button
                  className="hidden grid size-[27px] place-items-center rounded-lg border border-line bg-transparent text-[0.8rem] text-muted transition-colors hover:border-line-strong hover:bg-paper hover:text-ink max-[920px]:grid"
                  type="button"
                  onClick={viewModel.close}
                  aria-label="Close pane list"
                >
                  <AppIcon name="close" size={15} />
                </button>
              </div>
            </div>
            <div className="my-[17px] mb-[13px] h-px bg-line" />
            {viewModel.status === "loading" ? <p className="mb-3 text-[0.7rem] text-muted">Reading tmux…</p> : null}
            {viewModel.status === "error" ? (
              <div className="mb-3 text-[0.7rem] text-[#a45d51]">
                <p>{viewModel.errorMessage}</p>
                <button
                  className="rounded-[7px] bg-[#d8edf8] px-2.5 py-[7px] text-[0.65rem] font-bold text-[#3f6b84]"
                  type="button"
                  onClick={viewModel.refresh}
                >
                  Try again
                </button>
              </div>
            ) : null}
            {viewModel.status === "ready" && viewModel.panes.length === 0 ? (
              <p className="mb-3 text-[0.7rem] text-muted">No tmux panes found.</p>
            ) : null}
            <div className="mr-[-7px] flex min-h-0 flex-1 flex-col gap-[5px] overflow-auto pr-[7px] overscroll-contain [-webkit-overflow-scrolling:touch] [scrollbar-gutter:stable]">
              {viewModel.panes.map((pane) => {
                const selected = pane.hostPaneId === viewModel.selectedTarget;
                const avatarClass =
                  pane.kind === "shell" ? "text-[#53606a] bg-[#dce4e9]" : "text-[#4e713d] bg-[#dcefc8]";
                const stateClass =
                  pane.state === "waiting_input" || pane.state === "waiting_approval"
                    ? "text-[#9b712d]"
                    : pane.state === "failed"
                      ? "text-[#a45d51]"
                      : "text-[#8b938b]";
                const stateDotClass =
                  pane.state === "waiting_input" || pane.state === "waiting_approval"
                    ? "bg-amber shadow-[0_0_0_3px_rgb(244_185_94_/_14%)]"
                    : pane.state === "failed"
                      ? "bg-red"
                      : "bg-[#aeb5ad]";
                return (
                  <button
                    className={`flex w-full min-w-0 items-center gap-[9px] rounded-[10px] border p-2 text-left transition-colors hover:border-line hover:bg-white/70 ${selected ? "border-[#c8dfb3] bg-[#edf7e4]" : "border-transparent"}`}
                    type="button"
                    key={pane.id}
                    onClick={() => viewModel.select(pane)}
                  >
                    <span
                      className={`grid size-7 shrink-0 place-items-center rounded-lg font-mono text-[0.7rem] font-extrabold ${avatarClass}`}
                    >
                      {pane.kind === "shell" ? (
                        <AppIcon name="terminal" size={15} />
                      ) : (
                        (pane.agentId?.slice(0, 1) ?? "·").toUpperCase()
                      )}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col items-stretch gap-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <strong className="min-w-0 overflow-hidden text-[0.69rem] font-bold text-ellipsis whitespace-nowrap text-[#303631]">
                          {pane.name}
                        </strong>
                        <span className="shrink-0 font-mono text-[0.48rem] font-bold tracking-[0.04em] text-faint">
                          PANE {pane.paneIndex ?? "?"}
                        </span>
                        {selected ? (
                          <span className="shrink-0 font-mono text-[0.49rem] font-extrabold tracking-[0.08em] text-[#689449]">
                            OPEN
                          </span>
                        ) : null}
                      </span>
                      <small className="overflow-hidden font-mono text-[0.56rem] text-ellipsis whitespace-nowrap text-faint">
                        {pane.agentId ?? pane.title ?? "shell"} <span className="text-line-strong">·</span> {pane.cwd}
                      </small>
                    </span>
                    <span
                      className={`flex min-w-[52px] shrink-0 items-center justify-end gap-[5px] whitespace-nowrap text-[0.55rem] ${stateClass}`}
                    >
                      <span className={`size-[5px] rounded-full ${stateDotClass}`} />
                      {paneStateLabel(pane.state)}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-line pt-[13px] font-mono text-[0.55rem] text-faint">
              <span>
                <kbd className="mr-[3px] rounded border border-line-strong bg-[#e6e8e2] px-1 py-0.5 font-inherit text-[0.52rem] text-[#687068]">
                  ⌘
                </kbd>
                <kbd className="mr-[3px] rounded border border-line-strong bg-[#e6e8e2] px-1 py-0.5 font-inherit text-[0.52rem] text-[#687068]">
                  K
                </kbd>{" "}
                quick switch
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="size-[5px] rounded-full bg-lime-deep" /> synced
              </span>
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}
