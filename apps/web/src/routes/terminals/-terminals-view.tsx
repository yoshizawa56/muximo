import type { TerminalEndpoint } from "@muximo/contract/api";
import { ConnectionFlowLayout, FlowIntro } from "./-connection-flow-layout";
import type { TerminalsViewModel } from "./-terminals-viewmodel";

export function TerminalsView({ viewModel }: { viewModel: TerminalsViewModel }) {
  return (
    <ConnectionFlowLayout>
      <div className="mx-auto flex min-w-0 w-full max-w-[570px] flex-1 flex-col px-6 py-[58px] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pb-[calc(32px+var(--safe-area-bottom))] max-[620px]:pt-8">
        <FlowIntro
          step="STEP 1 / 2"
          title="Choose a terminal"
          description="Select the computer that owns the tmux sessions you want to control."
        />
        <section className="mt-1.5 min-w-0" aria-label="available terminals">
          <div className="mb-2.5 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 font-mono text-[0.56rem] font-bold tracking-[0.12em] text-[#638e6b]">
            <span className="shrink-0">AVAILABLE TERMINALS</span>
            <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2.5">
              {viewModel.connectionName ? (
                <small className="min-w-0 max-w-36 overflow-hidden text-[0.52rem] font-normal tracking-normal text-[#a7e8ae] text-ellipsis whitespace-nowrap">
                  {viewModel.connectionName}
                </small>
              ) : null}
              <small className="shrink-0 text-[0.52rem] font-normal tracking-normal text-[#416a49]">
                {viewModel.terminals.filter((terminal) => terminal.state === "online").length} online
              </small>
              <button
                className="shrink-0 rounded-[5px] border border-[#2d7140] bg-lime/8 px-[7px] py-1 font-mono text-[0.5rem] font-normal tracking-[0.03em] text-lime transition-colors hover:bg-lime/18 max-[920px]:min-h-11"
                type="button"
                onClick={viewModel.onOpenWorkspaces}
              >
                workspaces
              </button>
              <button
                className="shrink-0 rounded-[5px] border border-[#2d7140] bg-lime/8 px-[7px] py-1 font-mono text-[0.5rem] font-normal tracking-[0.03em] text-lime transition-colors hover:bg-lime/18 max-[920px]:min-h-11"
                type="button"
                onClick={viewModel.onOpenSettings}
              >
                settings
              </button>
            </div>
          </div>
          {viewModel.status === "loading" ? (
            <p className="mt-[18px] flex items-start gap-2 text-[0.62rem] leading-[1.5] text-[#56785c] max-[620px]:text-[0.72rem]">
              Connecting to muximod…
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
            {viewModel.terminals.map((terminal) => (
              <TerminalCard
                key={terminal.id}
                terminal={terminal}
                connectionName={viewModel.connectionName}
                onSelect={viewModel.onSelectTerminal}
              />
            ))}
          </div>
        </section>
        <p className="mt-[18px] flex items-start gap-2 text-[0.62rem] leading-[1.5] text-[#56785c] max-[620px]:text-[0.72rem]">
          <span className="grid size-[15px] shrink-0 place-items-center rounded-full border border-[#376f42] font-mono text-[0.54rem] text-[#9bd5a2]">
            i
          </span>{" "}
          Your phone only connects to machines visible on this tailnet.
        </p>
      </div>
    </ConnectionFlowLayout>
  );
}

function TerminalCard({
  terminal,
  connectionName,
  onSelect,
}: {
  terminal: TerminalEndpoint;
  connectionName: string | null;
  onSelect: (terminal: TerminalEndpoint) => void;
}) {
  const online = terminal.state === "online";
  const displayName = connectionName ?? terminal.name;
  const terminalDetails = connectionName
    ? `${terminal.name} · ${terminal.host} · ${terminal.tailnetIp}`
    : `${terminal.host} · ${terminal.tailnetIp}`;
  return (
    <button
      className={`group flex w-full min-w-0 items-center gap-3 rounded-[10px] border border-[#1c4526] bg-[rgb(7_19_10_/_79%)] p-[14px] text-left text-inherit transition-[border-color,background,transform] duration-150 hover:-translate-y-px hover:border-[#3d8b4c] hover:bg-[rgb(13_40_19_/_84%)] disabled:cursor-not-allowed disabled:opacity-45 max-[620px]:gap-[9px] max-[620px]:p-[11px] max-[620px]:min-h-[72px] ${!online ? "cursor-not-allowed" : ""}`}
      type="button"
      disabled={!online}
      onClick={() => onSelect(terminal)}
    >
      <span className="grid size-[35px] shrink-0 place-items-center rounded-[9px] border border-[#286039] bg-[#0a2110] font-mono text-[1.05rem] text-lime max-[620px]:size-[31px] max-[620px]:rounded-lg max-[620px]:text-[0.9rem]">
        ⌁
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-[5px]">
        <span className="flex min-w-0 items-center justify-between gap-2">
          <strong className="min-w-0 overflow-hidden text-[0.78rem] font-semibold text-[#d0f9d4] text-ellipsis whitespace-nowrap max-[620px]:text-[0.69rem]">
            {displayName}
          </strong>
          <span
            className={`flex shrink-0 items-center gap-[5px] font-mono text-[0.49rem] tracking-[0.08em] ${online ? "text-lime" : "text-[#66806b]"}`}
          >
            <span className={`size-[5px] rounded-full ${online ? "bg-lime-deep" : "bg-[#46604c]"}`} />
            {online ? "ONLINE" : "OFFLINE"}
          </span>
        </span>
        <small className="overflow-hidden font-mono text-[0.57rem] text-[#67946e] text-ellipsis whitespace-nowrap max-[620px]:text-[0.5rem]">
          {terminalDetails}
        </small>
        <small className="overflow-hidden font-mono text-[0.57rem] text-[#67946e] text-ellipsis whitespace-nowrap max-[620px]:text-[0.5rem]">
          {terminal.detail} · {terminal.lastSeen}
        </small>
      </span>
      <span className="shrink-0 text-[1.25rem] text-[#4b8254]">›</span>
    </button>
  );
}
