import { MuximoLogo } from "../../../../../app/components/muximo-logo";
import { PaneSelectionModal } from "./-pane-selection-modal-view";
import type { SessionOverviewViewModel } from "./-session-viewmodel";

export function SessionView({ viewModel }: { viewModel: SessionOverviewViewModel }) {
  return (
    <main className="flex h-[var(--app-viewport-height)] min-h-[var(--app-viewport-height)] flex-col overflow-x-hidden overflow-y-auto bg-flow-grid bg-[length:auto,32px_32px,32px_32px,auto] text-ink">
      <header className="flex min-h-[58px] shrink-0 items-center justify-between gap-3 border-b border-[#17391f] bg-[#030a05]/72 px-7 backdrop-blur-[16px] max-[620px]:min-h-[calc(56px+var(--safe-area-top))] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pt-[var(--safe-area-top)]">
        <div className="flex shrink-0 items-center gap-2">
          <button
            className="grid size-8 place-items-center rounded-lg border border-[#24522e] bg-[#08170b] text-[1.15rem] leading-none text-[#9bd5a2] transition-colors hover:border-lime-deep hover:text-lime max-[620px]:size-11"
            type="button"
            onClick={viewModel.onBack}
            aria-label="Back to sessions"
          >
            ‹
          </button>
          <MuximoLogo size={24} />
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-[3px] text-center">
          <span className="inline-flex items-center gap-1.5 font-mono text-[0.48rem] font-bold tracking-[0.12em] text-lime-deep">
            <span className="size-[5px] rounded-full bg-lime-deep shadow-[0_0_0_3px_rgb(57_214_91_/_12%)]" /> CONNECTED
          </span>
          <strong className="max-w-[min(50vw,320px)] overflow-hidden text-[0.77rem] text-ellipsis whitespace-nowrap text-[#d8ffdc] max-[620px]:max-w-[42vw] max-[620px]:text-[0.68rem]">
            {viewModel.session.name}
          </strong>
          <small className="max-w-[min(65vw,420px)] overflow-hidden font-mono text-[0.52rem] text-ellipsis whitespace-nowrap text-[#5d9168] max-[620px]:max-w-[44vw] max-[620px]:text-[0.45rem]">
            {viewModel.terminal.name}
          </small>
        </div>
        <button
          className="grid size-8 place-items-center rounded-lg border border-[#24522e] bg-[#08170b] text-[1.15rem] leading-none text-[#9bd5a2] transition-colors hover:border-lime-deep hover:text-lime max-[620px]:size-11"
          type="button"
          onClick={viewModel.onDisconnect}
        >
          ×
        </button>
      </header>

      <section className="mx-auto w-full max-w-[680px] flex-1 px-6 py-[52px] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pb-[calc(30px+var(--safe-area-bottom))] max-[620px]:pt-[38px]">
        <div className="mb-[25px]">
          <span className="flex items-center gap-2 font-mono text-[0.58rem] font-bold tracking-[0.14em] text-lime-deep">
            <span className="h-px w-[19px] bg-lime-deep shadow-[0_0_9px_rgb(57_214_91_/_60%)]" /> SESSION READY
          </span>
          <div className="flex items-end justify-between gap-3">
            <h1 className="my-[13px] mb-0 text-[clamp(1.6rem,5vw,2.05rem)] font-bold leading-[1.05] tracking-[-0.06em] text-[#dbffdf] max-[620px]:text-[1.62rem]">
              {viewModel.panes.length ? "Select a pane" : "No pane selected"}
            </h1>
          </div>
          <p className="m-0 max-w-[500px] text-[0.76rem] leading-[1.55] text-[#719176] max-[620px]:text-[0.88rem]">
            {viewModel.panes.length
              ? "Choose a pane to start viewing and interacting with it."
              : "Create a shell or agent pane to start working in this session."}
          </p>
        </div>
        <p className="mt-3.5 flex items-center gap-2 font-mono text-[0.52rem] leading-[1.4] text-[#5d9168] max-[620px]:text-[0.72rem]">
          <span className="text-[0.8rem] text-lime-deep">⌁</span> The session stays alive while you switch panes.
        </p>
      </section>
      <PaneSelectionModal
        panes={viewModel.panes}
        selectedTarget=""
        status={viewModel.status ?? "loading"}
        errorMessage={viewModel.errorMessage ?? null}
        onSelect={viewModel.onSelectPane}
        onClose={viewModel.onBack}
        onRefresh={viewModel.onRefresh}
        onCreatePane={viewModel.onCreatePane}
      />
    </main>
  );
}
