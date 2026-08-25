import { AppIcon } from "../../../../../../../app/components/app-icon";
import type { PaneLayoutOverlayVariant } from "../../-pane-layout-overlay-view";
import type { ControlRoomViewModel } from "./-control-room-viewmodel";
import { CustomKeyboardSettingsView, CustomKeyboardView } from "./-custom-keyboard-view";
import { PaneBoardView } from "./-pane-board-view";
import type { PaneBoardViewModel } from "./-pane-board-viewmodel";
import type { PaneViewModel } from "./-terminal-viewmodel";
import { toToastAgent, useWaitingNotices } from "./-waiting-notification-controller";
import { ToastPattern } from "./-waiting-notification-patterns";
import { useWindowMapGesture } from "./-window-map-gesture";

export function ControlRoomView({
  viewModel: controlRoomViewModel,
  layoutVariant = "ghost",
}: {
  viewModel: ControlRoomViewModel;
  layoutVariant?: PaneLayoutOverlayVariant;
}) {
  const viewModel: PaneViewModel = controlRoomViewModel.terminal;
  const keyboard = controlRoomViewModel.keyboard;
  const keyboardSettings = controlRoomViewModel.keyboardSettings;
  const paneBoard: PaneBoardViewModel = controlRoomViewModel.paneBoard;
  const onSessionSelect = controlRoomViewModel.onSessionSelect;
  const onNewPane = controlRoomViewModel.onNewPane;
  const windowMapSurfaceRef = useWindowMapGesture(paneBoard.open);
  const { notices, open: dismissNotice } = useWaitingNotices(paneBoard.panes);
  const selectedPane = paneBoard.panes.find((pane) => pane.tmuxPaneId === viewModel.target);
  const title = selectedPane?.name ?? viewModel.target;
  const agentName = selectedPane?.agentId ?? (selectedPane?.kind === "shell" ? "shell" : "agent");
  const shellMode = selectedPane?.kind === "shell";
  const waitingCount = paneBoard.panes.filter(
    (pane) => pane.state === "waiting_input" || pane.state === "waiting_approval",
  ).length;
  const runningCount = paneBoard.panes.filter((pane) => pane.state === "running").length;
  const connectionDotClass =
    viewModel.status === "connected"
      ? "bg-lime-deep shadow-[0_0_0_3px_rgb(57_214_91_/_12%)]"
      : viewModel.status === "connecting"
        ? "bg-amber"
        : "bg-red";
  const agentBadgeClass = shellMode ? "text-[#a6d5ae] bg-[#14301b]" : "text-[#9bffa7] bg-[#12351b]";
  const ownerPillClass =
    viewModel.viewportOwner === "desktop"
      ? "border-[#735c2c] text-amber bg-[#231b0b]"
      : "border-[#2b6838] text-lime bg-[#0b2110] shadow-[0_0_20px_rgb(57_214_91_/_9%)]";
  const headerButtonClass =
    "grid size-8 shrink-0 place-items-center rounded-lg border border-line-strong bg-[rgb(10_22_13_/_86%)] text-muted transition-colors hover:border-[#3d7548] hover:bg-[#102417] hover:text-lime max-[620px]:size-9";
  const windowMapButtonClass =
    "flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-[rgb(10_22_13_/_86%)] px-2 text-[#81a986] transition-colors hover:border-[#3d7548] hover:bg-[#102417] hover:text-lime max-[620px]:h-9";
  const windowMapCountClass =
    "flex items-center gap-1 rounded-[4px] px-[5px] py-[2px] font-mono text-[0.5rem] font-bold leading-none";
  const windowMapWaitingClass = `bg-[#221b0c] text-amber ${windowMapCountClass}`;
  const windowMapRunningClass = `bg-[#0b1c0f] text-lime ${windowMapCountClass}`;

  return (
    <main
      ref={windowMapSurfaceRef}
      className="flex h-[var(--app-viewport-height)] min-h-[var(--app-viewport-height)] flex-col overflow-hidden text-ink [touch-action:pan-x_pan-y]"
    >
      <header className="flex min-h-[52px] shrink-0 items-center gap-2 border-b border-line bg-[rgb(6_13_8_/_92%)] px-[10px] backdrop-blur-[18px] max-[920px]:min-h-[calc(50px+var(--safe-area-top))] max-[920px]:pl-[max(8px,var(--safe-area-left))] max-[920px]:pr-[max(8px,var(--safe-area-right))] max-[920px]:pt-[var(--safe-area-top)]">
        {onSessionSelect ? (
          <button
            className={headerButtonClass}
            type="button"
            onClick={onSessionSelect}
            aria-label="Back to session selection"
            title="Back to session selection"
          >
            <AppIcon name="arrow-left" size={16} />
          </button>
        ) : null}
        <span className={`inline-block size-[7px] shrink-0 rounded-full ${connectionDotClass}`} />
        <span className="grid size-5 shrink-0 place-items-center rounded-[6px] bg-[#14301b] text-lime">
          <AppIcon name="terminal" size={13} />
        </span>
        <span
          className={`shrink-0 rounded-[6px] px-[6px] py-[3px] font-mono text-[0.52rem] font-extrabold ${agentBadgeClass}`}
        >
          {shellMode ? "shell" : agentName}
        </span>
        <strong className="min-w-0 truncate text-[0.74rem] font-bold text-[#d8f4dc]">{title}</strong>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            className={windowMapButtonClass}
            type="button"
            onClick={paneBoard.toggle}
            aria-expanded={paneBoard.isOpen}
            aria-controls="tmux-window-map"
            aria-label={paneBoard.isOpen ? "Close tmux window map" : "Open tmux window map"}
            title={paneBoard.isOpen ? "Close window map" : "Open window map"}
          >
            <AppIcon name="layout" size={15} />
            {waitingCount > 0 ? (
              <span className={windowMapWaitingClass}>
                <span className="size-[5px] animate-pulse rounded-full bg-amber" />
                {waitingCount}
              </span>
            ) : null}
            {runningCount > 0 ? (
              <span className={windowMapRunningClass}>
                <span className="size-[5px] rounded-full bg-lime-deep" />
                {runningCount}
              </span>
            ) : null}
          </button>
          {onNewPane ? (
            <button
              className={headerButtonClass}
              type="button"
              onClick={onNewPane}
              aria-label="Add a pane"
              title="Add a pane"
            >
              <AppIcon name="new-pane" size={16} />
            </button>
          ) : null}
        </div>
      </header>

      <div className="mx-auto grid w-full max-w-[1560px] flex-1 min-h-0 grid-cols-[196px_minmax(0,1fr)_316px] gap-7 overflow-hidden p-[28px_32px_32px] max-[1180px]:grid-cols-[170px_minmax(0,1fr)_286px] max-[1180px]:gap-[18px] max-[1180px]:px-[22px] max-[920px]:flex max-[920px]:flex-col max-[920px]:p-0">
        <aside className="flex min-h-0 flex-col px-0 py-1.5 max-[920px]:hidden">
          <div className="pb-6">
            <div className="flex items-center gap-[7px] font-mono text-[0.62rem] font-bold leading-none tracking-[0.13em] text-muted">
              WORKSPACE
            </div>
            <div className="relative mt-[13px] flex items-center gap-2.5 rounded-xl border border-line bg-[rgb(10_22_13_/_72%)] px-2.5 py-3">
              <span className="grid size-7 place-items-center rounded-lg bg-[#12301a] text-lime">
                <AppIcon name="folder" size={17} />
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-1">
                <strong className="overflow-hidden text-[0.75rem] text-ellipsis whitespace-nowrap">
                  {selectedPane?.workspaceId ?? "session"}
                </strong>
                <small className="overflow-hidden text-[0.65rem] leading-[1.45] text-muted text-ellipsis whitespace-nowrap">
                  {selectedPane?.cwd ?? "~/work"}
                </small>
              </span>
              <span className="size-[5px] shrink-0 rounded-full bg-lime-deep shadow-[0_0_0_3px_rgb(57_214_91_/_12%)]" />
            </div>
          </div>

          <div className="border-t border-line pb-6 pt-[22px]">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-[7px] font-mono text-[0.62rem] font-bold leading-none tracking-[0.13em] text-muted">
                ATTENTION
              </span>
              <span className="grid min-w-[19px] size-[19px] place-items-center rounded-full bg-amber font-mono text-[0.62rem] font-extrabold text-[#0b170c]">
                {waitingCount}
              </span>
            </div>
            <div className="mt-3.5 flex items-center gap-2.5">
              <span className="grid size-[27px] place-items-center rounded-lg bg-amber font-extrabold text-[#0b170c]">
                !
              </span>
              <span className="flex flex-col gap-[3px]">
                <strong className="text-[0.7rem] text-[#b9dfbd]">
                  {waitingCount ? "Agents need you" : "All caught up"}
                </strong>
                <small className="text-[0.65rem] leading-[1.45] text-muted">
                  {waitingCount ? "Input or approval is waiting" : "No pending actions"}
                </small>
              </span>
            </div>
          </div>

          <div className="flex-1" />
          <div className="mb-3">
            <div className="flex items-center gap-[7px] font-mono text-[0.62rem] font-bold leading-none tracking-[0.13em] text-muted">
              SESSION MODE
            </div>
            <div className="mt-[13px] flex items-center gap-2 text-[0.68rem] font-semibold text-[#b9dfbd]">
              <span className="text-[0.8rem] text-lime">◉</span>
              <span>Shared tmux viewport</span>
            </div>
            <p className="m-0 mt-[9px] text-[0.65rem] leading-[1.45] text-muted">
              Mobile owns the viewport while you are here. PC activity hands it back automatically.
            </p>
          </div>
          <div className="flex items-center gap-[7px] border-t border-line pt-[15px] font-mono text-[0.62rem] text-[#596059]">
            <span className="size-[5px] rounded-full bg-lime-deep" /> muximod{" "}
            <span className="ml-auto text-faint">v0.1</span>
          </div>
        </aside>

        <section className="flex min-w-0 min-h-0 flex-col gap-5 max-[920px]:flex-1 max-[920px]:gap-0 max-[620px]:gap-[7px]">
          <div className="flex min-h-[74px] items-start justify-between gap-5 max-[920px]:hidden">
            <div className="min-w-0">
              <div className="flex items-center gap-[7px] font-mono text-[0.62rem] font-bold leading-none tracking-[0.13em] text-muted">
                <span className="size-1.5 rounded-full bg-lime-deep shadow-[0_0_0_3px_rgb(97_143_55_/_12%)]" /> LIVE
                SESSION
              </div>
              <h1 className="mb-[9px] mt-[10px] max-w-[650px] text-[clamp(1.25rem,2.2vw,1.85rem)] font-bold leading-[1.05] tracking-[-0.055em] text-ink">
                {title}
              </h1>
              <div className="flex flex-wrap items-center gap-2 font-mono text-[0.65rem] text-muted">
                <span
                  className={`rounded-md px-[7px] py-1 text-[0.61rem] font-extrabold uppercase tracking-[0.02em] ${agentBadgeClass}`}
                >
                  {agentName}
                </span>
                <span>{selectedPane?.cwd ?? "~/work"}</span>
                <span className="text-line-strong">·</span>
                <span className="max-[620px]:hidden">{viewModel.target}</span>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2 pt-1">
              <div
                className={`flex items-center gap-[7px] rounded-full border px-2.5 py-2 text-[0.67rem] font-bold ${ownerPillClass}`}
              >
                <span
                  className={`size-1.5 rounded-full ${viewModel.viewportOwner === "desktop" ? "bg-amber" : "bg-lime-deep"}`}
                />
                {viewModel.viewportOwner === "mobile" ? "You have control" : "PC has control"}
              </div>
              <span className="font-mono text-[0.6rem] text-faint">live / just now</span>
            </div>
          </div>

          <CustomKeyboardView viewModel={keyboard}>
            <section
              className="relative flex min-h-[450px] flex-1 flex-col overflow-hidden rounded-[15px] border border-[#1d4c29] bg-terminal shadow-[var(--shadow-app),0_0_0_7px_rgb(57_214_91_/_5%),0_0_70px_rgb(21_116_42_/_12%)] max-[920px]:min-h-0 max-[920px]:rounded-none max-[920px]:border-0 max-[920px]:shadow-none max-[620px]:rounded-[9px]"
              aria-label={`${viewModel.target} terminal`}
            >
              <div className="flex min-h-0 w-full flex-1 flex-col px-6 pb-[18px] pt-[23px] max-[920px]:pl-[max(12px,var(--safe-area-left))] max-[920px]:pr-[max(12px,var(--safe-area-right))] max-[920px]:pb-[max(12px,var(--safe-area-bottom))] max-[920px]:pt-3">
                <div
                  ref={viewModel.terminalContainerRef}
                  className="terminal-container min-h-0 w-full flex-1 touch-none [-webkit-touch-callout:none]"
                />
              </div>
              {viewModel.pasteState !== "idle" ? (
                <div
                  className="pointer-events-none absolute top-[16px] right-[16px] z-10 flex items-center gap-2 rounded-[9px] border border-[#1d4c29] bg-[rgb(7_16_8_/_94%)] px-3 py-2 font-mono text-[0.62rem] text-[#b9dfbd] shadow-[0_6px_24px_rgb(0_0_0_/_45%)]"
                  role="status"
                >
                  <span
                    className={`size-1.5 shrink-0 rounded-full ${viewModel.pasteState === "failed" ? "bg-red" : "bg-lime-deep"}`}
                  />
                  {viewModel.pasteState === "pasting"
                    ? "Pasting image…"
                    : viewModel.pasteState === "pasted"
                      ? "Image pasted"
                      : "Image paste failed"}
                </div>
              ) : null}
              {notices.length ? (
                <ToastPattern
                  agents={notices.map(toToastAgent)}
                  onOpen={(agent) => {
                    dismissNotice(agent.id);
                    const pane = paneBoard.panes.find((candidate) => candidate.tmuxPaneId === agent.target);
                    if (pane) paneBoard.select(pane);
                  }}
                />
              ) : null}
              <div className="flex min-h-7 shrink-0 items-center justify-between gap-3 border-t border-[#15351d] bg-[#071008] px-[13px] font-mono text-[0.58rem] text-[#657169] max-[920px]:hidden">
                <span className="inline-flex items-center gap-1.5 text-[#8cb793]">
                  <span className="size-[5px] rounded-full bg-lime-deep" />{" "}
                  {viewModel.status === "connected" ? "streaming" : viewModel.status}
                </span>
                <span>{viewModel.viewportReason ? `viewport · ${viewModel.viewportReason}` : "xterm / tmux"}</span>
                <span>UTF-8</span>
              </div>
            </section>
          </CustomKeyboardView>

          {viewModel.errorMessage ? (
            <div
              className="flex min-h-[54px] items-center justify-between gap-4 rounded-[11px] border border-[#6b302c] bg-[#26100e] px-[13px] py-2.5 max-[620px]:items-start"
              role="alert"
            >
              <span className="flex min-w-0 flex-col gap-[3px]">
                <strong className="text-[0.7rem]">Connection interrupted</strong>
                <small className="text-[0.65rem] text-muted">{viewModel.errorMessage}</small>
              </span>
              <button
                className="whitespace-nowrap rounded-[7px] bg-lime px-2.5 py-[7px] text-[0.65rem] font-bold text-[#061008]"
                type="button"
                onClick={viewModel.reconnect}
              >
                Reconnect
              </button>
            </div>
          ) : null}
          {viewModel.viewportOwner === "desktop" && viewModel.status === "connected" ? (
            <div
              className="flex min-h-[54px] items-center justify-between gap-4 rounded-[11px] border border-[#735c2c] bg-[#241c0d] px-[13px] py-2.5 max-[620px]:items-start"
              role="status"
            >
              <span className="flex min-w-0 flex-col gap-[3px]">
                <strong className="text-[0.7rem]">PC activity detected</strong>
                <small className="text-[0.65rem] text-muted">The viewport is back at desktop size.</small>
              </span>
              <button
                className="whitespace-nowrap rounded-[7px] bg-[#735c2c] px-2.5 py-[7px] text-[0.65rem] font-bold text-[#fff4cf]"
                type="button"
                onClick={viewModel.claim}
              >
                Take control
              </button>
            </div>
          ) : null}
        </section>

        <aside className="min-w-0 min-h-0 max-[920px]:fixed max-[920px]:inset-0 max-[920px]:z-20 max-[920px]:pointer-events-none">
          <div className="h-full max-[920px]:pointer-events-none">
            <PaneBoardView
              viewModel={paneBoard}
              alwaysOpen
              showLayout={paneBoard.isOpen}
              layoutVariant={layoutVariant}
            />
          </div>
        </aside>
      </div>
      {controlRoomViewModel.keyboardSettingsOpen ? (
        <div className="fixed inset-0 z-50">
          <CustomKeyboardSettingsView viewModel={keyboardSettings} />
        </div>
      ) : null}
    </main>
  );
}
