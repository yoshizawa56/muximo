import type { WorkspaceDetailViewModel } from "../-workspaces-viewmodel";

const fieldClass = "flex flex-col gap-[7px]";
const fieldLabelClass = "font-mono text-[0.56rem] font-bold tracking-[0.12em] text-[#6a9b72]";
const fieldHelpClass = "font-mono text-[0.52rem] leading-[1.4] text-[#5d9168] max-[620px]:text-[0.72rem]";
const inputClass =
  "min-h-[45px] w-full rounded-[9px] border border-[#24552e] bg-[rgb(6_20_9_/_82%)] px-[13px] font-mono text-base text-[#d8ffdc] outline-none transition-[border-color,box-shadow] placeholder:text-[#416a49] focus:border-lime-deep focus:shadow-[0_0_0_3px_rgb(57_214_91_/_12%)] max-[920px]:min-h-12";

export function WorkspaceDetailView({ viewModel }: { viewModel: WorkspaceDetailViewModel }) {
  if (viewModel.status === "loading") {
    return (
      <main className="flex h-[var(--app-viewport-height)] min-h-[var(--app-viewport-height)] flex-col bg-flow-grid p-6 text-ink">
        <p className="font-mono text-[0.62rem] text-[#5d9168]">Loading workspace…</p>
      </main>
    );
  }
  if (!viewModel.workspace) {
    return (
      <main className="flex h-[var(--app-viewport-height)] min-h-[var(--app-viewport-height)] flex-col bg-flow-grid p-6 text-ink">
        <p className="rounded-xl border border-red/38 bg-red/30 p-3 text-[0.72rem] text-[#ffb0aa]" role="alert">
          {viewModel.errorMessage ?? "Workspace not found"}
        </p>
        <button
          className="mt-4 inline-flex items-center gap-2 font-mono text-[0.64rem] text-[#76ad7e]"
          type="button"
          onClick={viewModel.onBack}
        >
          ‹ back to workspaces
        </button>
      </main>
    );
  }

  const workspace = viewModel.workspace;

  return (
    <main className="flex h-[var(--app-viewport-height)] min-h-[var(--app-viewport-height)] flex-col overflow-x-hidden overflow-y-auto bg-flow-grid bg-[length:auto,32px_32px,32px_32px,auto] text-ink">
      <header className="flex min-h-[58px] shrink-0 items-center justify-between gap-3 border-b border-[#17391f] bg-[#030a05]/72 px-7 backdrop-blur-[16px] max-[620px]:min-h-[calc(56px+var(--safe-area-top))] max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pt-[var(--safe-area-top)]">
        <button
          className="inline-flex items-center gap-2 font-mono text-[0.64rem] text-[#76ad7e] transition-colors hover:text-lime"
          type="button"
          onClick={viewModel.onBack}
        >
          ‹ workspaces
        </button>
        <span className="font-mono text-[0.52rem] text-[#78ae80]">{workspace.isGit ? "git" : "plain"} workspace</span>
      </header>
      <section className="mx-auto w-full max-w-[570px] flex-1 px-6 py-8 max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pb-[calc(32px+var(--safe-area-bottom))]">
        <div className="mb-6">
          <span className="flex items-center gap-2 font-mono text-[0.58rem] font-bold tracking-[0.14em] text-lime-deep">
            <span className="h-px w-[19px] bg-lime-deep" /> WORKSPACE SETTINGS
          </span>
          <h1 className="my-2 text-[1.6rem] font-bold tracking-[-0.05em] text-[#dbffdf]">{workspace.name}</h1>
          <p className="m-0 font-mono text-[0.58rem] text-[#638f6b]">{workspace.directory}</p>
          <p className="mt-1 font-mono text-[0.5rem] text-[#5d9168]">ID: {workspace.id}</p>
        </div>

        <div className="flex flex-col gap-[17px]">
          <label className={fieldClass}>
            <span className={fieldLabelClass}>WORKSPACE NAME</span>
            <input
              className={inputClass}
              value={viewModel.name}
              onChange={(event) => viewModel.onNameChange(event.target.value)}
              autoComplete="off"
            />
          </label>

          <label className={fieldClass}>
            <span className={fieldLabelClass}>
              SETUP SCRIPT PATH <small className="tracking-normal">(optional)</small>
            </span>
            <input
              className={inputClass}
              value={viewModel.setupScriptPath}
              onChange={(event) => viewModel.onSetupScriptPathChange(event.target.value)}
              placeholder="/Users/me/.config/muximo/setup"
              autoComplete="off"
            />
          </label>
          <label className={fieldClass}>
            <span className={fieldLabelClass}>
              CLEANUP SCRIPT PATH <small className="tracking-normal">(optional)</small>
            </span>
            <input
              className={inputClass}
              value={viewModel.cleanupScriptPath}
              onChange={(event) => viewModel.onCleanupScriptPathChange(event.target.value)}
              placeholder="/Users/me/.config/muximo/cleanup"
              autoComplete="off"
            />
          </label>
          <small className={fieldHelpClass}>
            Hook paths are host-side executable files. They run with the created worktree as cwd. Empty clears the hook.
          </small>

          <label className={fieldClass}>
            <span className={fieldLabelClass}>
              WORKTREE COPY PATTERNS <small className="tracking-normal">(one per line)</small>
            </span>
            <textarea
              className="min-h-[90px] w-full resize-y rounded-[9px] border border-[#24552e] bg-[rgb(6_20_9_/_82%)] px-[13px] py-[11px] font-mono text-base leading-[1.45] text-[#d8ffdc] outline-none placeholder:text-[#416a49] focus:border-lime-deep max-[920px]:min-h-12"
              value={viewModel.worktreeCopyPatterns}
              onChange={(event) => viewModel.onWorktreeCopyPatternsChange(event.target.value)}
              placeholder={".env\nconfig/*.local.json"}
              rows={4}
              spellCheck={false}
            />
          </label>
          <small className={fieldHelpClass}>
            Relative patterns like <code className="font-mono text-[#a9e9af]">.env</code> or{" "}
            <code className="font-mono text-[#a9e9af]">config{/**/}*.local.json</code> copy unmanaged files before the
            setup hook.
          </small>

          {viewModel.saveError ? (
            <p className="m-0 text-[0.62rem] leading-[1.45] text-[#ff9a8f]" role="alert">
              {viewModel.saveError}
            </p>
          ) : null}
          <button
            className="flex min-h-11 w-full items-center justify-between gap-3 rounded-[9px] border border-[#4a9a57] bg-lime px-[15px] text-[0.71rem] font-bold text-[#061008] hover:bg-[#b0ffb8] disabled:opacity-35"
            type="button"
            onClick={viewModel.onSave}
            disabled={!viewModel.canSave || viewModel.isSaving}
          >
            {viewModel.isSaving ? "Saving…" : "Save workspace"}
            <span>→</span>
          </button>

          <div className="mt-2 border-t border-[#17391f] pt-4">
            <h2 className="font-mono text-[0.56rem] font-bold tracking-[0.12em] text-[#6a9b72]">Danger zone</h2>
            <p className="mt-1 font-mono text-[0.52rem] text-[#5d9168]">
              Unregistering removes the workspace from muximod but never deletes the directory.
            </p>
            <button
              className="mt-2 flex min-h-10 w-full items-center justify-center rounded-[9px] border border-red/40 bg-red/10 text-[0.62rem] text-[#ffb0aa] hover:bg-red/20 disabled:opacity-35"
              type="button"
              onClick={viewModel.onDelete}
              disabled={viewModel.isDeleting}
            >
              {viewModel.isDeleting ? "Deleting…" : "Unregister workspace"}
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}
