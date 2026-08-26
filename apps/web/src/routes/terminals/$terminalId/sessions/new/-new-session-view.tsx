import { MuximoLogo } from "../../../../../app/components/muximo-logo";
import { WorkspacePickerView } from "../-workspace-picker-view";
import { workspacePickerState } from "../-workspace-picker-viewmodel";
import type { NewSessionViewModel } from "./-new-session-viewmodel";

export function NewSessionView({ viewModel }: { viewModel: NewSessionViewModel }) {
  const canCreate = viewModel.name.trim().length > 0 && workspacePickerState(viewModel.workspacePicker).canContinue;

  return (
    <main className="flex h-[var(--app-viewport-height)] min-h-[var(--app-viewport-height)] flex-col overflow-x-hidden overflow-y-auto bg-flow-grid bg-[length:auto,32px_32px,32px_32px,auto] text-ink">
      <header className="flex min-h-[58px] shrink-0 items-center justify-between gap-3 border-b border-[#17391f] bg-[#030a05]/72 px-7 backdrop-blur-[16px] max-[620px]:min-h-[calc(56px+var(--safe-area-top))] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pt-[var(--safe-area-top)]">
        <div className="flex min-w-0 items-center gap-3">
          <MuximoLogo size={26} />
          <button
            className="inline-flex min-w-0 items-center gap-2 font-mono text-[0.64rem] text-[#76ad7e] transition-colors hover:text-lime"
            type="button"
            onClick={viewModel.onBack}
          >
            ‹ <span className="truncate">{viewModel.terminal.name}</span>
          </button>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 font-mono text-[0.52rem] text-[#78ae80]">
          <span className="size-[5px] rounded-full bg-lime-deep" /> {viewModel.terminal.tailnetIp}
        </span>
      </header>
      <section className="mx-auto w-full max-w-[570px] flex-1 px-6 py-[52px] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pb-[calc(32px+var(--safe-area-bottom))] max-[620px]:pt-8">
        <div className="mb-[29px] max-[620px]:mb-[27px]">
          <span className="flex items-center gap-2 font-mono text-[0.58rem] font-bold tracking-[0.14em] text-lime-deep">
            <span className="h-px w-[19px] bg-lime-deep shadow-[0_0_9px_rgb(57_214_91_/_60%)]" /> NEW SESSION
          </span>
          <h1 className="my-[14px] mb-[10px] text-[clamp(1.65rem,5vw,2.15rem)] font-bold leading-[1.05] tracking-[-0.06em] text-[#dbffdf] max-[620px]:mt-3 max-[620px]:text-[1.62rem]">
            Create a tmux session
          </h1>
          <p className="m-0 max-w-[430px] text-[0.79rem] leading-[1.55] text-[#719176] max-[620px]:text-[0.88rem]">
            Start a tmux session on {viewModel.terminal.name}. Choose its initial directory, then add agent panes when
            it is ready.
          </p>
        </div>

        <form
          className="flex flex-col gap-[17px]"
          onSubmit={(event) => {
            event.preventDefault();
            if (canCreate) viewModel.onCreate();
          }}
        >
          <label className="flex flex-col gap-[7px]">
            <span className="font-mono text-[0.56rem] font-bold tracking-[0.12em] text-[#6a9b72]">SESSION NAME</span>
            <input
              className="min-h-[45px] w-full rounded-[9px] border border-[#24552e] bg-[rgb(6_20_9_/_82%)] px-[13px] font-mono text-base text-[#d8ffdc] outline-none transition-[border-color,box-shadow] placeholder:text-[#416a49] focus:border-lime-deep focus:shadow-[0_0_0_3px_rgb(57_214_91_/_12%)] max-[920px]:min-h-12"
              value={viewModel.name}
              onChange={(event) => viewModel.onNameChange(event.target.value)}
              placeholder="muximo"
              autoComplete="off"
            />
            <small className="font-mono text-[0.52rem] text-[#5d9168] max-[620px]:text-[0.72rem]">
              Use a short name you can recognize on every device.
            </small>
          </label>
          <WorkspacePickerView viewModel={viewModel.workspacePicker} showMode={false} />
          <div className="flex items-start gap-2.5 rounded-[9px] border border-[#1e4828] bg-[rgb(7_24_11_/_65%)] p-3 text-lime">
            <span className="grid size-5 shrink-0 place-items-center rounded-md border border-[#326e3d] font-mono text-[0.8rem]">
              ⌁
            </span>
            <span className="flex flex-col gap-1">
              <strong className="text-[0.68rem] text-[#bdeec3]">Shell first</strong>
              <small className="font-mono text-[0.52rem] text-[#5d9168] max-[620px]:text-[0.72rem]">
                Create agent panes from the session overview when you need them.
              </small>
            </span>
          </div>
          {viewModel.errorMessage ? (
            <p className="m-0 text-[0.62rem] leading-[1.45] text-[#ff9a8f]" role="alert">
              {viewModel.errorMessage}
            </p>
          ) : null}
          <button
            className="mt-1 flex min-h-[45px] w-full items-center justify-between gap-3 rounded-[9px] border border-[#4a9a57] bg-lime px-[15px] text-[0.71rem] font-bold text-[#061008] transition-colors hover:bg-[#b0ffb8] disabled:cursor-not-allowed disabled:opacity-35 max-[920px]:min-h-[52px] max-[920px]:text-[0.88rem]"
            type="submit"
            disabled={!canCreate || viewModel.isCreating}
          >
            {viewModel.isCreating ? "Creating session…" : "Create session"}
            <span className="text-[1.1rem]">{viewModel.isCreating ? "…" : "→"}</span>
          </button>
        </form>
      </section>
    </main>
  );
}
