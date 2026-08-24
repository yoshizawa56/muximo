import { ConnectionFlowLayout, FlowIntro } from "../../../../-connection-flow-layout";
import type { DisconnectedViewModel } from "./-disconnected-viewmodel";

export function DisconnectedView({ viewModel }: { viewModel: DisconnectedViewModel }) {
  return (
    <ConnectionFlowLayout>
      <div className="mx-auto flex w-full max-w-[570px] flex-1 flex-col justify-center px-6 py-[34px] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pb-[calc(32px+var(--safe-area-bottom))] max-[620px]:pt-5">
        <div className="mb-[22px] grid size-12 place-items-center rounded-[15px] border border-[#396c45] bg-[#0b2110] text-[1.35rem] text-[#9bd5a2] shadow-[0_0_30px_rgb(57_214_91_/_8%)]">
          ↯
        </div>
        <FlowIntro
          step="DISCONNECTED"
          title="Mobile is disconnected"
          description="The tmux session is still running on the terminal."
        />
        <div className="grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-[#1b4827] bg-[#1b4827]">
          <span className="flex min-w-0 flex-col gap-[5px] bg-[#071409] p-[13px]">
            <small className="font-mono text-[0.5rem] tracking-[0.1em] text-[#588061]">TERMINAL</small>
            <strong className="overflow-hidden text-[0.68rem] text-[#c8f5cd] text-ellipsis whitespace-nowrap">
              {viewModel.selectedTerminal?.name}
            </strong>
            <em className="overflow-hidden font-mono text-[0.5rem] not-italic text-[#699572] text-ellipsis whitespace-nowrap">
              {viewModel.selectedTerminal?.tailnetIp}
            </em>
          </span>
          <span className="flex min-w-0 flex-col gap-[5px] bg-[#071409] p-[13px]">
            <small className="font-mono text-[0.5rem] tracking-[0.1em] text-[#588061]">SESSION</small>
            <strong className="overflow-hidden text-[0.68rem] text-[#c8f5cd] text-ellipsis whitespace-nowrap">
              {viewModel.selectedSession?.name}
            </strong>
            <em className="overflow-hidden font-mono text-[0.5rem] not-italic text-[#699572] text-ellipsis whitespace-nowrap">
              session preserved
            </em>
          </span>
        </div>
        <button
          className="mt-6 flex min-h-[45px] w-full items-center justify-between gap-3 rounded-[9px] border border-[#4a9a57] bg-lime px-[15px] text-[0.71rem] font-bold text-[#061008] transition-colors hover:bg-[#b0ffb8] max-[920px]:min-h-[52px] max-[920px]:text-[0.88rem]"
          type="button"
          onClick={viewModel.onReconnect}
        >
          Reconnect to session<span className="text-[1.1rem]">→</span>
        </button>
        <button
          className="mt-2 flex min-h-[37px] w-full items-center justify-center rounded-[9px] border border-[#214d2b] bg-transparent text-[0.63rem] text-[#78a77f] transition-colors hover:border-[#3c8248] hover:text-[#b6eabd] max-[920px]:min-h-11"
          type="button"
          onClick={viewModel.onChooseTerminal}
        >
          Choose another terminal
        </button>
      </div>
    </ConnectionFlowLayout>
  );
}
