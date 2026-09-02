import type { ReactNode } from "react";
import { MuximoLogo } from "../../app/components/muximo-logo";

export function ConnectionFlowLayout({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-[var(--app-viewport-height)] min-h-[var(--app-viewport-height)] flex-col overflow-x-hidden overflow-y-auto bg-flow-grid bg-[length:auto,32px_32px,32px_32px,auto] text-ink">
      <header className="flex min-h-[58px] shrink-0 items-center justify-between gap-3 border-b border-[#17391f] bg-[#030a05]/72 px-7 backdrop-blur-[16px] max-[620px]:min-h-[calc(56px+var(--safe-area-top))] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pt-[var(--safe-area-top)]">
        <div className="flex min-w-0 flex-1 items-center gap-[9px]">
          <MuximoLogo size={26} />
          <strong className="text-[0.92rem] tracking-[-0.04em] text-[#d5ffd9]">
            muximo<span className="text-lime-deep">.</span>
          </strong>
          <small className="ml-0.5 border-l border-[#285332] pl-[11px] font-mono text-[0.58rem] uppercase tracking-[0.12em] text-[#67916e]">
            connect
          </small>
        </div>
        <div className="flex shrink-0 items-center gap-[7px] font-mono text-[0.55rem] tracking-[0.11em] text-[#78ae80]">
          <span className="size-1.5 shrink-0 rounded-full bg-lime-deep shadow-[0_0_0_3px_rgb(57_214_91_/_12%)]" />{" "}
          TAILNET
        </div>
      </header>
      {children}
      <footer className="flex shrink-0 items-center justify-between gap-3 px-7 pb-[calc(18px+env(safe-area-inset-bottom))] font-mono text-[0.52rem] text-[#456d4d] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:text-[0.47rem]">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-[5px] rounded-full bg-lime-deep" /> encrypted over your tailnet
        </span>
        <span>muximod</span>
      </footer>
    </main>
  );
}

export function FlowIntro({ step, title, description }: { step: string; title: string; description: string }) {
  return (
    <div className="mb-[34px] max-[620px]:mb-[27px]">
      <span className="flex items-center gap-2 font-mono text-[0.58rem] font-bold tracking-[0.14em] text-lime-deep">
        <span className="h-px w-[19px] bg-lime-deep shadow-[0_0_9px_rgb(57_214_91_/_60%)]" />
        {step}
      </span>
      <h1 className="my-[14px] mb-[10px] text-[clamp(1.65rem,5vw,2.15rem)] font-bold leading-[1.05] tracking-[-0.06em] text-[#dbffdf] max-[620px]:mt-3 max-[620px]:text-[1.62rem]">
        {title}
      </h1>
      <p className="m-0 max-w-[430px] text-[0.79rem] leading-[1.55] text-[#719176] max-[620px]:text-[0.88rem]">
        {description}
      </p>
    </div>
  );
}
