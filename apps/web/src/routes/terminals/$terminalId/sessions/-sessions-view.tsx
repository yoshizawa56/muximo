import type { TmuxSession } from "@muximo/contract/api";
import { ConnectionFlowLayout, FlowIntro } from "../../-connection-flow-layout";
import type { SessionsViewModel } from "./-sessions-viewmodel";

export function SessionsView({ viewModel }: { viewModel: SessionsViewModel }) {
  return (
    <ConnectionFlowLayout>
      <div className="mx-auto w-full max-w-[570px] flex-1 px-6 py-[58px] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pb-[calc(32px+var(--safe-area-bottom))] max-[620px]:pt-8">
        <button
          className="mb-[26px] inline-flex items-center gap-[7px] font-mono text-[0.64rem] text-[#76ad7e] transition-colors hover:text-lime"
          type="button"
          onClick={viewModel.onBack}
        >
          ‹ <span>{viewModel.selectedTerminal?.name ?? "terminal"}</span>
        </button>
        <FlowIntro
          step="STEP 2 / 2"
          title="Choose a tmux session"
          description="Pick the session to open on your phone. It stays alive when you disconnect."
        />
        {viewModel.selectedTerminal ? (
          <div className="-mt-3 mb-[25px] flex w-fit items-center gap-2 rounded-[7px] border border-[#1d4b28] bg-[rgb(7_24_11_/_68%)] px-[9px] py-[7px] font-mono text-[0.58rem] text-[#a9dfae]">
            <span className="size-1.5 shrink-0 rounded-full bg-lime-deep shadow-[0_0_0_3px_rgb(57_214_91_/_12%)]" />
            <span>{viewModel.selectedTerminal.name}</span>
            <small className="text-[#52765a]">{viewModel.selectedTerminal.tailnetIp}</small>
          </div>
        ) : null}
        <section className="mt-1.5" aria-label="tmux sessions">
          <div className="mb-2.5 flex items-center justify-between gap-3 font-mono text-[0.56rem] font-bold tracking-[0.12em] text-[#638e6b]">
            <span>TMUX SESSIONS</span>
            <span className="inline-flex items-center gap-2.5">
              <small className="text-[0.52rem] font-normal tracking-normal text-[#416a49]">
                {viewModel.sessions.length} found
              </small>
              <button
                className="rounded-[5px] border border-[#2d7140] bg-lime/8 px-[7px] py-1 font-mono text-[0.5rem] font-normal tracking-[0.03em] text-lime transition-colors hover:bg-lime/18 max-[920px]:min-h-11"
                type="button"
                onClick={viewModel.onCreateSession}
              >
                + new session
              </button>
            </span>
          </div>
          {viewModel.status === "loading" ? (
            <p className="mt-[18px] flex items-start gap-2 text-[0.62rem] leading-[1.5] text-[#56785c] max-[620px]:text-[0.72rem]">
              Reading tmux sessions…
            </p>
          ) : null}
          {viewModel.status === "error" ? (
            <p
              className="mt-[18px] flex items-start gap-2 text-[0.62rem] leading-[1.5] text-[#ff9a8f] max-[620px]:text-[0.72rem]"
              role="alert"
            >
              {viewModel.errorMessage}
            </p>
          ) : null}
          <div className="flex flex-col gap-[7px]">
            {viewModel.sessions.map((session) => (
              <SessionCard
                key={session.name}
                session={session}
                selected={session.name === viewModel.selectedSession?.name}
                onSelect={viewModel.onSelectSession}
              />
            ))}
          </div>
        </section>
        <p className="mt-[18px] flex items-start gap-2 text-[0.62rem] leading-[1.5] text-[#56785c] max-[620px]:text-[0.72rem]">
          <span className="grid size-[15px] shrink-0 place-items-center rounded-full border border-[#376f42] font-mono text-[0.54rem] text-[#9bd5a2]">
            ↗
          </span>{" "}
          Tap a session to connect. The session overview opens before any pane is attached.
        </p>
      </div>
    </ConnectionFlowLayout>
  );
}

function SessionCard({
  session,
  selected,
  onSelect,
}: {
  session: TmuxSession;
  selected: boolean;
  onSelect: (session: TmuxSession) => void;
}) {
  return (
    <button
      className={`group flex w-full min-w-0 items-start gap-3 rounded-[10px] border border-[#1c4526] bg-[rgb(7_19_10_/_79%)] p-[14px] text-left text-inherit transition-[border-color,background,transform] duration-150 hover:-translate-y-px hover:border-[#3d8b4c] hover:bg-[rgb(13_40_19_/_84%)] max-[620px]:gap-[9px] max-[620px]:p-[11px] max-[620px]:min-h-[72px] ${selected ? "border-[#3d8b4c] bg-[rgb(13_40_19_/_84%)] shadow-[inset_3px_0_0_var(--color-lime-deep),0_0_22px_rgb(57_214_91_/_8%)]" : ""}`}
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(session)}
    >
      <span className="grid size-[35px] shrink-0 place-items-center rounded-[9px] border border-[#286039] bg-[#0e2b15] font-mono text-[0.86rem] text-[#a8dfae] max-[620px]:size-[31px] max-[620px]:rounded-lg max-[620px]:text-[0.9rem]">
        ▦
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <strong className="min-w-0 overflow-hidden text-[0.78rem] font-semibold text-[#d0f9d4] text-ellipsis whitespace-nowrap max-[620px]:text-[0.69rem]">
            {session.name}
          </strong>
          <span
            className={`shrink-0 rounded-[4px] border px-[5px] py-[2px] font-mono text-[0.46rem] font-bold tracking-[0.08em] ${session.managed ? "border-[#2d7140] bg-lime/8 text-lime" : "border-[#4b4b2d] bg-[#282817] text-[#c6b879]"}`}
          >
            {session.managed ? "MANAGED" : "UNMANAGED"}
          </span>
        </span>
        <small className="overflow-hidden font-mono text-[0.57rem] text-[#67946e] text-ellipsis whitespace-nowrap max-[620px]:text-[0.5rem]">
          {session.detail}
        </small>
      </span>
      <span className="flex min-w-12 shrink-0 flex-col items-end gap-0.5 font-mono text-[#65936d]">
        <strong className="text-[0.85rem] text-[#c9f6ce] max-[620px]:text-[0.74rem]">{session.paneCount}</strong>
        <small className="text-[0.48rem]">panes</small>
        {session.waitingCount ? (
          <em className="whitespace-nowrap text-[0.48rem] not-italic text-amber">{session.waitingCount} waiting</em>
        ) : null}
      </span>
    </button>
  );
}
