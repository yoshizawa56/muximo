import { MuximoLogo } from "../../app/components/muximo-logo";
import { QrPairingScanner } from "./-qr-pairing-scanner";
import type { SettingsViewModel } from "./-settings-viewmodel";

export function SettingsView({ viewModel }: { viewModel: SettingsViewModel }) {
  return (
    <main className="flex h-[var(--app-viewport-height)] min-h-[var(--app-viewport-height)] flex-col overflow-x-hidden overflow-y-auto bg-flow-grid bg-[length:auto,32px_32px,32px_32px,auto] text-ink">
      <header className="flex min-h-[58px] shrink-0 items-center justify-between border-b border-[#17391f] bg-[#030a05]/72 px-7 backdrop-blur-[16px] max-[620px]:min-h-[calc(56px+var(--safe-area-top))] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pt-[var(--safe-area-top)]">
        <div className="flex min-w-0 items-center gap-3">
          <MuximoLogo size={26} />
          {viewModel.hasSavedProfile ? (
            <button
              className="inline-flex items-center gap-[7px] font-mono text-[0.64rem] text-[#76ad7e] transition-colors hover:text-lime"
              type="button"
              onClick={viewModel.onBack}
            >
              ‹ <span>connections</span>
            </button>
          ) : (
            <span className="font-mono text-[0.64rem] text-[#76ad7e]">connection setup</span>
          )}
        </div>
        <span className="inline-flex items-center gap-2 font-mono text-[0.55rem] tracking-[0.11em] text-[#78ae80]">
          <span className="size-1.5 rounded-full bg-lime-deep shadow-[0_0_0_3px_rgb(57_214_91_/_12%)]" /> MUXIMOD
          CONNECTION
        </span>
      </header>

      <section className="mx-auto w-full max-w-[570px] flex-1 px-6 py-[58px] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pb-[calc(30px+var(--safe-area-bottom))] max-[620px]:pt-[38px]">
        <div className="mb-[34px] max-[620px]:mb-[27px]">
          <span className="flex items-center gap-2 font-mono text-[0.58rem] font-bold tracking-[0.14em] text-lime-deep">
            <span className="h-px w-[19px] bg-lime-deep shadow-[0_0_9px_rgb(57_214_91_/_60%)]" /> PAIR WITH MUXIMOD
          </span>
          <h1 className="my-[14px] mb-[10px] text-[clamp(1.65rem,5vw,2.15rem)] font-bold leading-[1.05] tracking-[-0.06em] text-[#dbffdf] max-[620px]:mt-3 max-[620px]:text-[1.62rem]">
            Scan the pairing QR
          </h1>
          <p className="m-0 max-w-[430px] text-[0.79rem] leading-[1.55] text-[#719176] max-[620px]:text-[0.88rem]">
            Run muximo pair on the host, then scan the QR code shown in the terminal.
          </p>
        </div>

        {viewModel.errorMessage && !viewModel.isPairingQr ? (
          <p
            className="mb-4 rounded-xl border border-red/38 bg-red/30 p-[0.85rem_1rem] whitespace-pre-wrap break-words text-[#ffb0aa]"
            role="alert"
          >
            {viewModel.errorMessage}
          </p>
        ) : null}
        {viewModel.isPairingQr ? (
          <div
            className="mb-4 rounded-xl border border-[#5bd6b2]/35 bg-[#1c5b4c]/28 p-[0.85rem_1rem] text-[#b9f5de]"
            role="status"
          >
            {viewModel.pairingMessage ?? "Pairing…"}
          </div>
        ) : null}
        {viewModel.isScanningQr ? (
          <QrPairingScanner onScan={viewModel.onQrValue} onClose={viewModel.onCloseQrScanner} />
        ) : null}

        {!viewModel.isScanningQr && !viewModel.isPairingQr ? (
          <button
            className="mb-4 flex min-h-[45px] w-full items-center justify-between gap-3 rounded-[9px] border border-[#4a9a57] bg-lime px-[15px] text-[0.71rem] font-bold text-[#061008] transition-colors hover:bg-[#b0ffb8] max-[920px]:min-h-[52px] max-[920px]:text-[0.88rem]"
            type="button"
            onClick={viewModel.onOpenQrScanner}
          >
            Scan QR code<span>⌁</span>
          </button>
        ) : null}

        {viewModel.hasSavedProfile && !viewModel.isScanningQr && !viewModel.isPairingQr ? (
          <button
            className="flex min-h-[37px] w-full items-center justify-center rounded-[9px] border border-[#214d2b] bg-transparent text-[0.63rem] text-[#9c7662] transition-colors hover:border-[#3c8248] hover:text-[#b6eabd] max-[920px]:min-h-11"
            type="button"
            onClick={viewModel.onClear}
          >
            Forget saved connection
          </button>
        ) : null}

        <dl
          aria-label="Application version"
          className="mt-9 border-t border-[#17391f] pt-4 font-mono text-[0.56rem] text-[#5d9168]"
        >
          <div className="flex items-center justify-between gap-4">
            <dt className="tracking-[0.12em]">APP VERSION</dt>
            <dd className="m-0 text-[#a7e8ae]">v{viewModel.appInfo.version}</dd>
          </div>
          <div className="mt-2 flex items-center justify-between gap-4">
            <dt className="tracking-[0.12em]">BUILD</dt>
            <dd className="m-0 text-[#7caf83]">{viewModel.appInfo.build}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
