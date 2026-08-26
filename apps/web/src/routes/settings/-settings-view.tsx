import { MuximoLogo } from "../../app/components/muximo-logo";
import { QrPairingScanner } from "./-qr-pairing-scanner";
import type { SettingsViewModel } from "./-settings-viewmodel";

export function SettingsView({ viewModel }: { viewModel: SettingsViewModel }) {
  const pairingFlowActive =
    viewModel.isScanningQr ||
    viewModel.isPreparingPairing ||
    viewModel.pairingPreview !== null ||
    viewModel.isPairingQr;

  return (
    <main className="flex h-[var(--app-viewport-height)] min-h-[var(--app-viewport-height)] flex-col overflow-x-hidden overflow-y-auto bg-flow-grid bg-[length:auto,32px_32px,32px_32px,auto] text-ink">
      <header className="flex min-h-[58px] shrink-0 items-center justify-between border-b border-[#17391f] bg-[#030a05]/72 px-7 backdrop-blur-[16px] max-[620px]:min-h-[calc(56px+var(--safe-area-top))] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pt-[var(--safe-area-top)]">
        <div className="flex min-w-0 items-center gap-3">
          <MuximoLogo size={26} />
          {viewModel.profiles.length > 0 ? (
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
        {!pairingFlowActive ? <ConnectionList viewModel={viewModel} /> : <PairingFlow viewModel={viewModel} />}

        {viewModel.errorMessage && !viewModel.isPairingQr ? (
          <p
            className="mt-4 rounded-xl border border-red/38 bg-red/30 p-[0.85rem_1rem] whitespace-pre-wrap break-words text-[#ffb0aa]"
            role="alert"
          >
            {viewModel.errorMessage}
          </p>
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

function ConnectionList({ viewModel }: { viewModel: SettingsViewModel }) {
  return (
    <>
      <div className="mb-[34px] max-[620px]:mb-[27px]">
        <span className="flex items-center gap-2 font-mono text-[0.58rem] font-bold tracking-[0.14em] text-lime-deep">
          <span className="h-px w-[19px] bg-lime-deep shadow-[0_0_9px_rgb(57_214_91_/_60%)]" />
          {viewModel.profiles.length > 0 ? "SAVED CONNECTIONS" : "PAIR WITH MUXIMOD"}
        </span>
        <h1 className="my-[14px] mb-[10px] text-[clamp(1.65rem,5vw,2.15rem)] font-bold leading-[1.05] tracking-[-0.06em] text-[#dbffdf] max-[620px]:mt-3 max-[620px]:text-[1.62rem]">
          {viewModel.profiles.length > 0 ? "Connections" : "Scan the pairing QR"}
        </h1>
        <p className="m-0 max-w-[430px] text-[0.79rem] leading-[1.55] text-[#719176] max-[620px]:text-[0.88rem]">
          {viewModel.profiles.length > 0
            ? "Choose a saved muximod connection or add another one for a different development instance."
            : "Run muximo pair on the host, then scan the QR code shown in the terminal."}
        </p>
      </div>

      <button
        className="mb-5 flex min-h-[45px] w-full items-center justify-between gap-3 rounded-[9px] border border-[#4a9a57] bg-lime px-[15px] text-[0.71rem] font-bold text-[#061008] transition-colors hover:bg-[#b0ffb8] max-[920px]:min-h-[52px] max-[920px]:text-[0.88rem]"
        type="button"
        onClick={viewModel.onOpenQrScanner}
      >
        {viewModel.profiles.length > 0 ? "Add connection" : "Scan QR code"}
        <span>⌁</span>
      </button>

      {viewModel.profiles.length > 0 ? (
        <section className="grid gap-2" aria-label="saved connections">
          {viewModel.profiles.map((profile) => (
            <ConnectionProfileCard key={profile.id} profile={profile} viewModel={viewModel} />
          ))}
        </section>
      ) : null}
    </>
  );
}

function ConnectionProfileCard({
  profile,
  viewModel,
}: {
  profile: SettingsViewModel["profiles"][number];
  viewModel: SettingsViewModel;
}) {
  const isActive = profile.id === viewModel.activeProfileId;
  const isEditing = profile.id === viewModel.editingProfileId;

  return (
    <article
      className={`rounded-[10px] border p-[14px] transition-colors max-[620px]:p-[11px] ${isActive ? "border-[#3d8b4c] bg-[rgb(13_40_19_/_84%)]" : "border-[#1c4526] bg-[rgb(7_19_10_/_79%)]"}`}
    >
      {isEditing ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            viewModel.onSaveRename();
          }}
        >
          <label
            className="font-mono text-[0.55rem] tracking-[0.1em] text-[#78ae80]"
            htmlFor={`connection-name-${profile.id}`}
          >
            CONNECTION NAME
          </label>
          <input
            className="min-h-10 w-full rounded-[7px] border border-[#4a9a57] bg-[#061008] px-3 font-mono text-[0.76rem] text-[#d0f9d4] outline-none placeholder:text-[#56785c] focus:ring-1 focus:ring-lime"
            id={`connection-name-${profile.id}`}
            maxLength={120}
            onChange={(event) => viewModel.onRenameChange(event.target.value)}
            value={viewModel.editingProfileName}
          />
          <div className="flex justify-end gap-2">
            <button
              className="rounded-[6px] border border-[#214d2b] px-3 py-2 font-mono text-[0.56rem] text-[#78a77f] transition-colors hover:border-[#3c8248] hover:text-[#b6eabd] max-[920px]:min-h-11"
              type="button"
              onClick={viewModel.onCancelRename}
            >
              Cancel
            </button>
            <button
              className="rounded-[6px] border border-[#4a9a57] bg-lime px-3 py-2 font-mono text-[0.56rem] font-bold text-[#061008] transition-colors hover:bg-[#b0ffb8] max-[920px]:min-h-11"
              type="submit"
            >
              Save
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="m-0 overflow-hidden text-[0.82rem] font-semibold text-[#d0f9d4] text-ellipsis whitespace-nowrap">
                {profile.name}
              </h2>
              <p className="mt-1.5 mb-0 overflow-hidden font-mono text-[0.58rem] text-[#67946e] text-ellipsis whitespace-nowrap">
                {profile.muximodBaseUrl}
              </p>
            </div>
            {isActive ? (
              <span className="flex shrink-0 items-center gap-[5px] font-mono text-[0.49rem] tracking-[0.08em] text-lime">
                <span className="size-[5px] rounded-full bg-lime-deep" /> CURRENT
              </span>
            ) : null}
          </div>
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            {!isActive ? (
              <button
                className="rounded-[6px] border border-[#2d7140] bg-lime/8 px-3 py-2 font-mono text-[0.56rem] text-lime transition-colors hover:bg-lime/18 max-[920px]:min-h-11"
                type="button"
                onClick={() => viewModel.onSelectProfile(profile.id)}
              >
                Use
              </button>
            ) : null}
            <button
              className="rounded-[6px] border border-[#2d7140] bg-lime/8 px-3 py-2 font-mono text-[0.56rem] text-lime transition-colors hover:bg-lime/18 max-[920px]:min-h-11"
              type="button"
              onClick={() => viewModel.onStartRename(profile.id)}
            >
              Rename
            </button>
            <button
              className="rounded-[6px] border border-[#214d2b] px-3 py-2 font-mono text-[0.56rem] text-[#9c7662] transition-colors hover:border-[#3c8248] hover:text-[#b6eabd] max-[920px]:min-h-11"
              type="button"
              onClick={() => viewModel.onRemoveProfile(profile.id)}
            >
              Forget
            </button>
          </div>
        </>
      )}
    </article>
  );
}

function PairingFlow({ viewModel }: { viewModel: SettingsViewModel }) {
  if (viewModel.isScanningQr) {
    return (
      <>
        <FlowHeading title="Scan the pairing QR" description="Point your camera at the QR code shown by muximo pair." />
        <QrPairingScanner onScan={viewModel.onQrValue} onClose={viewModel.onCloseQrScanner} />
      </>
    );
  }

  if (viewModel.isPreparingPairing) {
    return (
      <>
        <FlowHeading title="Checking the connection" description="Verifying the muximod endpoint from the QR code." />
        <p
          className="rounded-xl border border-[#5bd6b2]/35 bg-[#1c5b4c]/28 p-[0.85rem_1rem] text-[#b9f5de]"
          role="status"
        >
          {viewModel.pairingMessage ?? "Checking QR code…"}
        </p>
      </>
    );
  }

  if (viewModel.isPairingQr) {
    return (
      <>
        <FlowHeading
          title="Waiting for approval"
          description="Approve this connection request in the muximod terminal."
        />
        <div
          className="rounded-xl border border-[#5bd6b2]/35 bg-[#1c5b4c]/28 p-[0.85rem_1rem] text-[#b9f5de]"
          role="status"
        >
          {viewModel.pairingMessage ?? "Pairing…"}
        </div>
      </>
    );
  }

  if (!viewModel.pairingPreview) return null;
  return (
    <>
      <FlowHeading
        title="Name this connection"
        description="Choose a label that helps you recognize this muximod instance."
      />
      <dl
        aria-label="muximod connection details"
        className="mb-5 grid gap-2 rounded-xl border border-[#1c4526] bg-[rgb(7_19_10_/_79%)] p-4 font-mono text-[0.58rem]"
      >
        <div className="grid gap-1">
          <dt className="tracking-[0.12em] text-[#5d9168]">ENDPOINT</dt>
          <dd className="m-0 overflow-hidden break-all text-[#b6eabd]">{viewModel.pairingPreview.muximodBaseUrl}</dd>
        </div>
        <div className="grid gap-1">
          <dt className="tracking-[0.12em] text-[#5d9168]">SERVER ID</dt>
          <dd className="m-0 text-[#7caf83]">{shortServerId(viewModel.pairingPreview.serverId)}</dd>
        </div>
      </dl>
      <label
        className="grid gap-2 font-mono text-[0.58rem] font-bold tracking-[0.12em] text-[#78ae80]"
        htmlFor="pairing-connection-name"
      >
        CONNECTION NAME
        <input
          className="min-h-11 rounded-[9px] border border-[#4a9a57] bg-[#061008] px-3 font-mono text-[0.78rem] font-normal tracking-normal text-[#d0f9d4] outline-none placeholder:text-[#56785c] focus:ring-1 focus:ring-lime"
          id="pairing-connection-name"
          maxLength={120}
          onChange={(event) => viewModel.onPairingNameChange(event.target.value)}
          value={viewModel.pairingName}
        />
      </label>
      <p className="mt-2 mb-5 text-[0.65rem] leading-[1.5] text-[#56785c]">This name is saved on this device only.</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          className="min-h-[45px] rounded-[9px] border border-[#214d2b] bg-transparent font-mono text-[0.62rem] text-[#78a77f] transition-colors hover:border-[#3c8248] hover:text-[#b6eabd] max-[920px]:min-h-11"
          type="button"
          onClick={viewModel.onCancelPairing}
        >
          Back
        </button>
        <button
          className="min-h-[45px] rounded-[9px] border border-[#4a9a57] bg-lime font-mono text-[0.62rem] font-bold text-[#061008] transition-colors hover:bg-[#b0ffb8] max-[920px]:min-h-11"
          type="button"
          onClick={viewModel.onConfirmPairing}
        >
          Connect
        </button>
      </div>
    </>
  );
}

function FlowHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="mb-[27px]">
      <span className="flex items-center gap-2 font-mono text-[0.58rem] font-bold tracking-[0.14em] text-lime-deep">
        <span className="h-px w-[19px] bg-lime-deep shadow-[0_0_9px_rgb(57_214_91_/_60%)]" /> PAIR WITH MUXIMOD
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

function shortServerId(serverId: string): string {
  return serverId.length > 16 ? `${serverId.slice(0, 8)}…${serverId.slice(-6)}` : serverId;
}
