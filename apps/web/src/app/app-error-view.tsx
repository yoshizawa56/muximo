import type { ReactNode } from "react";
import { MuximoLogo } from "./components/muximo-logo";

type AppErrorViewProps = {
  error: unknown;
  title?: string;
  description?: string;
  onRetry?: () => void;
  children?: ReactNode;
};

export function AppErrorView({
  error,
  title = "The control room hit an unexpected error",
  description = "The page could not be rendered. Retry the current route or return to the terminal list.",
  onRetry,
  children,
}: AppErrorViewProps) {
  const message = errorMessage(error);

  return (
    <main className="grid min-h-[var(--app-viewport-height)] place-items-center p-6 text-ink" role="alert">
      <div className="w-full max-w-[520px] rounded-[24px] border border-line-strong bg-[linear-gradient(145deg,rgb(12_19_14_/_96%),rgb(2_5_3_/_96%))] p-[clamp(24px,7vw,48px)] shadow-app">
        <div className="mb-6 flex items-center gap-2.5">
          <MuximoLogo size={34} />
          <span className="font-semibold tracking-[-0.04em] text-ink">
            muximo<span className="text-lime-deep">.</span>
          </span>
        </div>
        <div
          className="mb-6 grid size-[42px] place-items-center rounded-[13px] border border-red/48 bg-red/10 font-mono text-xl font-extrabold text-red"
          aria-hidden="true"
        >
          !
        </div>
        <p className="font-mono text-[0.62rem] font-bold tracking-[0.13em] text-muted">CONTROL ROOM / RECOVERY</p>
        <h1 className="my-2 mb-3 max-w-[15ch] text-[clamp(1.65rem,6vw,2.5rem)] font-bold leading-[1.04] tracking-[-0.055em] text-ink">
          {title}
        </h1>
        <p className="m-0 max-w-[42ch] leading-[1.6] text-muted">{description}</p>
        <div className="mt-7 flex flex-wrap gap-2.5">
          <button
            className="inline-flex min-h-[42px] items-center justify-center rounded-[11px] border border-line-strong bg-lime px-4 text-[0.78rem] font-bold text-[#061008]"
            type="button"
            onClick={onRetry ?? reloadPage}
          >
            Retry
          </button>
          <a
            className="inline-flex min-h-[42px] items-center justify-center rounded-[11px] border border-line-strong bg-white/4 px-4 text-[0.78rem] font-bold text-ink no-underline"
            href="/terminals"
          >
            Terminal list
          </a>
        </div>
        <details className="mt-6 text-[0.72rem] text-faint">
          <summary>Technical details</summary>
          <code className="mt-2.5 block max-h-40 overflow-auto rounded-[10px] border border-line bg-terminal p-3 font-inherit leading-[1.5] whitespace-pre-wrap break-words text-muted">
            {message}
          </code>
        </details>
        {children}
      </div>
    </main>
  );
}

export function errorMessage(error: unknown): string {
  if (error == null) return "Unknown error";
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;

  try {
    const serialized = JSON.stringify(error);
    return serialized && serialized !== "{}" ? serialized : "Unknown error";
  } catch {
    return "Unknown error";
  }
}

function reloadPage() {
  window.location.reload();
}
