import type { WorkspacesListViewModel } from "./-workspaces-viewmodel";
import { filterWorkspaces } from "./-workspaces-viewmodel";

export function WorkspacesListView({ viewModel }: { viewModel: WorkspacesListViewModel }) {
  const filtered = filterWorkspaces(viewModel.workspaces, viewModel.query);

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
        <span className="inline-flex items-center gap-1.5 font-mono text-[0.52rem] text-[#78ae80]">
          <span className="size-[5px] rounded-full bg-lime-deep" /> {viewModel.workspaces.length} registered
        </span>
      </header>
      <section className="mx-auto w-full max-w-[640px] flex-1 px-6 py-8 max-[620px]:px-[max(14px,var(--safe-area-right))] max-[620px]:pb-[calc(32px+var(--safe-area-bottom))]">
        <div className="mb-6">
          <span className="flex items-center gap-2 font-mono text-[0.58rem] font-bold tracking-[0.14em] text-lime-deep">
            <span className="h-px w-[19px] bg-lime-deep shadow-[0_0_9px_rgb(57_214_91_/_60%)]" /> WORKSPACES
          </span>
          <h1 className="my-2 text-[clamp(1.5rem,5vw,1.95rem)] font-bold leading-[1.05] tracking-[-0.06em] text-[#dbffdf]">
            Workspace settings
          </h1>
          <p className="m-0 max-w-[520px] text-[0.76rem] leading-[1.5] text-[#719176]">
            Each workspace owns its setup and cleanup hooks and worktree copy patterns. Tap a workspace to edit it as a
            child screen.
          </p>
        </div>

        <div className="mb-4 flex gap-2">
          <input
            className="min-h-[42px] flex-1 rounded-[9px] border border-[#24552e] bg-[rgb(6_20_9_/_82%)] px-3 font-mono text-sm text-[#d8ffdc] outline-none placeholder:text-[#416a49] focus:border-lime-deep max-[920px]:min-h-11"
            placeholder="Filter by name or directory"
            value={viewModel.query}
            onChange={(event) => viewModel.onQueryChange(event.target.value)}
          />
          <button
            className="shrink-0 rounded-[9px] border border-[#4a9a57] bg-lime px-4 text-[0.68rem] font-bold text-[#061008] hover:bg-[#b0ffb8] max-[920px]:min-h-11"
            type="button"
            onClick={viewModel.onOpenCreate}
          >
            + Register
          </button>
        </div>

        {viewModel.status === "loading" ? (
          <p className="font-mono text-[0.62rem] text-[#5d9168]">Loading workspaces…</p>
        ) : null}
        {viewModel.status === "error" ? (
          <p className="rounded-xl border border-red/38 bg-red/30 p-3 text-[0.72rem] text-[#ffb0aa]" role="alert">
            {viewModel.errorMessage ?? "Could not load workspaces"}
          </p>
        ) : null}
        {viewModel.status === "ready" && filtered.length === 0 && viewModel.workspaces.length === 0 ? (
          <p className="rounded-[10px] border border-[#1e4828] bg-[rgb(7_24_11_/_55%)] p-4 font-mono text-[0.62rem] text-[#5d9168]">
            No workspace registered yet. Register a host directory to configure its hooks.
          </p>
        ) : null}
        {viewModel.status === "ready" && filtered.length === 0 && viewModel.workspaces.length > 0 ? (
          <p className="font-mono text-[0.62rem] text-[#5d9168]">No matches for “{viewModel.query}”.</p>
        ) : null}

        <div className="mt-2 flex flex-col gap-2">
          {filtered.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              onClick={() => viewModel.onSelectWorkspace(workspace.id)}
              className="flex flex-col gap-1.5 rounded-[10px] border border-[#1e4828] bg-[rgb(7_24_11_/_70%)] p-3 text-left transition-colors hover:border-[#3d8b4c] hover:bg-[rgb(13_40_19_/_82%)]"
            >
              <span className="flex items-center gap-2">
                <strong className="text-[0.78rem] text-[#c3f4c9]">{workspace.name}</strong>
                <span
                  className={`rounded px-1.5 py-0.5 font-mono text-[0.48rem] ${workspace.isGit ? "bg-lime/15 text-lime" : "bg-[#1e4828] text-[#5d9168]"}`}
                >
                  {workspace.isGit ? "git" : "plain"}
                </span>
                <span className="ml-auto font-mono text-[0.52rem] text-[#5d9168]">
                  {workspace.worktreeCopyPatterns.length} patterns
                </span>
              </span>
              <span className="truncate font-mono text-[0.58rem] text-[#638f6b]">{workspace.directory}</span>
              <span className="flex gap-3 font-mono text-[0.5rem] text-[#5d9168]">
                <span>setup: {workspace.setupScriptPath ?? "—"}</span>
                <span>cleanup: {workspace.cleanupScriptPath ?? "—"}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
