import { ConnectionFlowLayout, FlowIntro } from "../../../../-connection-flow-layout";
import type { ConnectingViewModel } from "./-connecting-viewmodel";

export function ConnectingView({ viewModel }: { viewModel: ConnectingViewModel }) {
  const steps = [
    "Reach terminal over Tailscale",
    "Authenticate with muximod",
    `Attach to ${viewModel.selectedSession?.name ?? "tmux"}`,
  ];
  return (
    <ConnectionFlowLayout>
      <div className="mx-auto flex w-full max-w-[570px] flex-1 flex-col justify-center px-6 py-[34px] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pb-[calc(32px+var(--safe-area-bottom))] max-[620px]:pt-5">
        <span className="mb-[25px] flex gap-1.5" aria-hidden="true">
          <span className="size-[7px] rounded-full bg-lime-deep shadow-[0_0_14px_rgb(57_214_91_/_45%)]" />
          <span className="size-[7px] rounded-full bg-lime-deep opacity-60 shadow-[0_0_14px_rgb(57_214_91_/_45%)]" />
          <span className="size-[7px] rounded-full bg-lime-deep opacity-30 shadow-[0_0_14px_rgb(57_214_91_/_45%)]" />
        </span>
        <FlowIntro
          step="CONNECTING"
          title="Opening your session"
          description={`${viewModel.selectedTerminal?.name ?? "Terminal"} · ${viewModel.selectedSession?.name ?? "tmux session"}`}
        />
        <div className="flex flex-col gap-3 rounded-[10px] border border-[#183f22] bg-[rgb(6_18_9_/_70%)] p-[15px]">
          {steps.map((step, index) => (
            <div
              className={`flex items-center gap-2.5 text-[0.67rem] ${index < viewModel.connectionStep ? "text-[#8bc795]" : index === viewModel.connectionStep ? "text-[#b9efbf]" : "text-[#4c7354]"}`}
              key={step}
            >
              <span
                className={`grid size-5 place-items-center rounded-full border font-mono text-[0.56rem] ${index < viewModel.connectionStep ? "border-[#3d8b4c] bg-[#0e2b15] text-lime" : index === viewModel.connectionStep ? "border-lime-deep text-lime shadow-[0_0_14px_rgb(57_214_91_/_18%)]" : "border-[#1e4b29] text-[#547c5b]"}`}
              >
                {index < viewModel.connectionStep ? "✓" : index + 1}
              </span>
              <small>{step}</small>
            </div>
          ))}
        </div>
        <button
          className="mt-6 flex min-h-[45px] w-full items-center justify-between gap-3 rounded-[9px] border border-[#4a9a57] bg-lime px-[15px] text-[0.71rem] font-bold text-[#061008] transition-colors hover:bg-[#b0ffb8] max-[920px]:min-h-[52px] max-[920px]:text-[0.88rem]"
          type="button"
          onClick={viewModel.onOpenSessionOverview}
        >
          Open session overview<span className="text-[1.1rem]">→</span>
        </button>
        <button
          className="mt-2 flex min-h-[37px] w-full items-center justify-center rounded-[9px] border border-[#214d2b] bg-transparent text-[0.63rem] text-[#78a77f] transition-colors hover:border-[#3c8248] hover:text-[#b6eabd] max-[920px]:min-h-11"
          type="button"
          onClick={viewModel.onBack}
        >
          Cancel
        </button>
      </div>
    </ConnectionFlowLayout>
  );
}
