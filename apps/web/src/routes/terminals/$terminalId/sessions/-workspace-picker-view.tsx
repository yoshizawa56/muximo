import type { WorkspacePickerViewModel } from "./-workspace-picker-viewmodel";
import { workspacePickerState } from "./-workspace-picker-viewmodel";

const fieldClass = "flex flex-col gap-[7px]";
const fieldLabelClass = "font-mono text-[0.56rem] font-bold tracking-[0.12em] text-[#6a9b72]";
const fieldHelpClass = "font-mono text-[0.52rem] leading-[1.4] text-[#5d9168] max-[620px]:text-[0.72rem]";
const inputClass =
  "min-h-[45px] w-full rounded-[9px] border border-[#24552e] bg-[rgb(6_20_9_/_82%)] px-[13px] font-mono text-base text-[#d8ffdc] outline-none transition-[border-color,box-shadow] placeholder:text-[#416a49] focus:border-lime-deep focus:shadow-[0_0_0_3px_rgb(57_214_91_/_12%)] max-[920px]:min-h-12";

export function WorkspacePickerView({
  viewModel,
  showMode = true,
}: {
  viewModel: WorkspacePickerViewModel;
  showMode?: boolean;
}) {
  const state = workspacePickerState(viewModel);
  const workspaceUnavailable =
    viewModel.workspaceStatus === "error" || (viewModel.workspaceStatus === "ready" && !viewModel.workspaces.length);

  return (
    <>
      <label className={fieldClass}>
        <span className={fieldLabelClass}>REGISTERED WORKSPACE</span>
        <select
          className={`${inputClass} py-0`}
          value={viewModel.workspaceId}
          onChange={(event) => viewModel.onWorkspaceChange(event.target.value)}
          disabled={viewModel.workspaceStatus === "loading" || workspaceUnavailable}
          aria-describedby="workspace-picker-help"
        >
          <option value="">
            {viewModel.workspaceStatus === "loading"
              ? "Loading workspaces…"
              : workspaceUnavailable
                ? "No registered workspaces"
                : "Choose a workspace"}
          </option>
          {viewModel.workspaces.map((workspace) => (
            <option value={workspace.id} key={workspace.id}>
              {workspace.name} · {workspace.directory}
            </option>
          ))}
        </select>
        <small className={fieldHelpClass} id="workspace-picker-help">
          Choose a workspace registered on the host. The host keeps its directory and hook paths.
        </small>
      </label>

      <button
        className="self-start rounded-md border border-[#3d8b4c] bg-lime/9 px-[9px] py-1.5 font-mono text-[0.55rem] text-lime transition-colors hover:bg-lime/18 max-[920px]:min-h-11"
        type="button"
        onClick={viewModel.onOpenRegistration}
      >
        {viewModel.registrationOpen ? "Workspace registration" : "+ Register workspace"}
      </button>

      {viewModel.workspaceStatus === "error" ? (
        <p className="m-0 text-[0.62rem] leading-[1.45] text-[#ff9a8f]" role="alert">
          {viewModel.errorMessage ?? "Could not load registered workspaces"}
        </p>
      ) : null}
      {viewModel.workspaceStatus === "ready" && !viewModel.workspaces.length ? (
        <p className="-mt-2 font-mono text-[0.52rem] leading-[1.45] text-[#5d9168] max-[620px]:text-[0.72rem]">
          No workspace is registered on this host yet.
        </p>
      ) : null}

      {viewModel.registrationOpen ? (
        <section
          className="flex flex-col gap-[11px] rounded-[10px] border border-[#24552e] bg-[rgb(5_18_8_/_58%)] p-[13px]"
          aria-label="Register workspace"
        >
          <div className="flex items-center justify-between gap-2">
            <div>
              <strong className="block text-[0.68rem] text-[#c3f4c9]">Register a workspace</strong>
              <small className="block font-mono text-[0.57rem] leading-[1.4] text-[#638f6b]">
                Pick a host directory, then optionally attach personal executable hooks.
              </small>
            </div>
            <button
              className="shrink-0 rounded-md border border-[#326e3d] bg-[rgb(13_40_19_/_72%)] px-2 py-1.5 font-mono text-[0.53rem] text-[#a9e9af] transition-colors hover:bg-lime/18 max-[920px]:min-h-11"
              type="button"
              onClick={viewModel.onCloseRegistration}
            >
              Close
            </button>
          </div>

          <label className={fieldClass}>
            <span className={fieldLabelClass}>DIRECTORY</span>
            <input
              className={inputClass}
              value={viewModel.registrationDirectory}
              onChange={(event) => viewModel.onRegistrationDirectoryChange(event.target.value)}
              placeholder="/Users/me/work/muximo"
              autoComplete="off"
            />
          </label>

          <div className="flex items-center justify-start gap-2">
            <button
              className="shrink-0 rounded-md border border-[#326e3d] bg-[rgb(13_40_19_/_72%)] px-2 py-1.5 font-mono text-[0.53rem] text-[#a9e9af] transition-colors hover:bg-lime/18 disabled:opacity-50 max-[920px]:min-h-11"
              type="button"
              onClick={() => viewModel.onBrowseWorkspace(viewModel.registrationDirectory.trim() || undefined)}
              disabled={viewModel.browserStatus === "loading"}
            >
              {viewModel.browserStatus === "loading" ? "Browsing…" : "Browse directory"}
            </button>
            <button
              className="shrink-0 rounded-md border border-[#326e3d] bg-[rgb(13_40_19_/_72%)] px-2 py-1.5 font-mono text-[0.53rem] text-[#a9e9af] transition-colors hover:bg-lime/18 disabled:opacity-50 max-[920px]:min-h-11"
              type="button"
              onClick={() => viewModel.onBrowseWorkspace()}
              disabled={viewModel.browserStatus === "loading"}
            >
              Allowed roots
            </button>
          </div>

          {viewModel.browserPath ? (
            <small className="font-mono text-[0.57rem] leading-[1.4] text-[#638f6b]">
              Browsing: {viewModel.browserPath}
            </small>
          ) : null}
          {viewModel.browserStatus === "error" ? (
            <p className="m-0 text-[0.62rem] leading-[1.45] text-[#ff9a8f]" role="alert">
              {viewModel.errorMessage ?? "Could not browse host directories"}
            </p>
          ) : null}
          {viewModel.browserStatus === "ready" && viewModel.workspaceCandidates.length ? (
            <div className="flex max-h-[170px] flex-col gap-1.5 overflow-y-auto rounded-lg border border-[#1e4828] bg-[rgb(7_24_11_/_55%)] p-[7px] overscroll-contain [scrollbar-gutter:stable] [-webkit-overflow-scrolling:touch]">
              {viewModel.workspaceCandidates.map((candidate) => (
                <div className="flex items-center justify-between gap-2" key={candidate.directory}>
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 flex-col items-start gap-1 rounded-md p-1 text-left transition-colors hover:bg-lime/10"
                    onClick={() => viewModel.onSelectWorkspaceDirectory(candidate.directory)}
                  >
                    <strong className="max-w-full overflow-hidden text-[0.68rem] text-ellipsis whitespace-nowrap text-[#c3f4c9]">
                      {candidate.name}
                    </strong>
                    <small className="max-w-full overflow-hidden font-mono text-[0.57rem] text-ellipsis whitespace-nowrap text-[#638f6b]">
                      {candidate.directory}
                    </small>
                  </button>
                  <button
                    className="shrink-0 rounded-md border border-[#326e3d] bg-[rgb(13_40_19_/_72%)] px-2 py-1.5 font-mono text-[0.53rem] text-[#a9e9af] transition-colors hover:bg-lime/18 max-[920px]:min-h-11"
                    type="button"
                    onClick={() => viewModel.onBrowseWorkspace(candidate.directory)}
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <label className={fieldClass}>
            <span className={fieldLabelClass}>
              SETUP SCRIPT PATH <small className="tracking-normal">(OPTIONAL)</small>
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
              CLEANUP SCRIPT PATH <small className="tracking-normal">(OPTIONAL)</small>
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
            Hook paths are host-side executable files and are not expected inside the worktree. They run with the
            created worktree as the current directory.
          </small>

          <label className={fieldClass}>
            <span className={fieldLabelClass}>
              WORKTREE COPY PATTERNS <small className="tracking-normal">(OPTIONAL · ONE PER LINE)</small>
            </span>
            <textarea
              className="min-h-[45px] w-full resize-y rounded-[9px] border border-[#24552e] bg-[rgb(6_20_9_/_82%)] px-[13px] py-[11px] font-mono text-base leading-[1.45] text-[#d8ffdc] outline-none transition-[border-color,box-shadow] placeholder:text-[#416a49] focus:border-lime-deep focus:shadow-[0_0_0_3px_rgb(57_214_91_/_12%)] max-[920px]:min-h-12"
              value={viewModel.worktreeCopyPatterns}
              onChange={(event) => viewModel.onWorktreeCopyPatternsChange(event.target.value)}
              placeholder={".env\n.env.local\nconfig/*.local.json"}
              rows={4}
              spellCheck={false}
            />
          </label>
          <small className={fieldHelpClass}>
            Relative patterns such as <code className="font-mono text-[#a9e9af]">.env</code> or{" "}
            <code className="font-mono text-[#a9e9af]">config{/**/}*.local.json</code> copy unmanaged files before the
            setup hook runs.
          </small>

          {viewModel.registrationError ? (
            <p className="m-0 text-[0.62rem] leading-[1.45] text-[#ff9a8f]" role="alert">
              {viewModel.registrationError}
            </p>
          ) : null}
          <button
            className="mt-0.5 flex min-h-10 w-full items-center justify-between gap-3 rounded-[9px] border border-[#4a9a57] bg-lime px-[15px] text-[0.71rem] font-bold text-[#061008] transition-colors hover:bg-[#b0ffb8] disabled:cursor-not-allowed disabled:opacity-35 max-[920px]:min-h-[52px] max-[920px]:text-[0.88rem]"
            type="button"
            onClick={viewModel.onRegisterWorkspace}
            disabled={viewModel.isRegisteringWorkspace || !viewModel.registrationDirectory.trim()}
          >
            {viewModel.isRegisteringWorkspace ? "Registering…" : "Register workspace"}
            <span>{viewModel.isRegisteringWorkspace ? "…" : "→"}</span>
          </button>
        </section>
      ) : null}

      {showMode ? (
        <fieldset className="mt-0.5 flex flex-col gap-2 border-0 p-0">
          <legend className="font-mono text-[0.53rem] tracking-[0.1em] text-[#75a97d]">WORKSPACE MODE</legend>
          <div className="grid grid-cols-2 gap-[7px] max-[620px]:grid-cols-1">
            <label
              className={`flex min-w-0 items-start gap-2 rounded-lg border border-[#1e4828] bg-[rgb(7_24_11_/_70%)] p-2.5 text-[#82b488] transition-colors max-[920px]:min-h-14 max-[920px]:p-3 ${viewModel.mode === "workspace" ? "border-[#3d8b4c] bg-[rgb(13_40_19_/_82%)] shadow-[inset_3px_0_0_var(--color-lime-deep)]" : ""}`}
            >
              <input
                type="radio"
                name="workspace-mode"
                checked={viewModel.mode === "workspace"}
                onChange={() => viewModel.onModeChange("workspace")}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <strong className="text-[0.65rem] text-[#c3f4c9]">Workspace</strong>
                <small className="text-[0.57rem] leading-[1.4] text-[#638f6b] max-[620px]:text-[0.72rem]">
                  Use the selected directory directly.
                </small>
              </span>
            </label>
            <label
              className={`flex min-w-0 items-start gap-2 rounded-lg border border-[#1e4828] bg-[rgb(7_24_11_/_70%)] p-2.5 text-[#82b488] transition-colors max-[920px]:min-h-14 max-[920px]:p-3 ${viewModel.mode === "worktree" ? "border-[#3d8b4c] bg-[rgb(13_40_19_/_82%)] shadow-[inset_3px_0_0_var(--color-lime-deep)]" : ""} ${state.selectedWorkspace?.isGit ? "" : "cursor-not-allowed opacity-38"}`}
            >
              <input
                type="radio"
                name="workspace-mode"
                checked={viewModel.mode === "worktree"}
                onChange={() => viewModel.onModeChange("worktree")}
                disabled={!state.selectedWorkspace?.isGit}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <strong className="text-[0.65rem] text-[#c3f4c9]">Git worktree</strong>
                <small className="text-[0.57rem] leading-[1.4] text-[#638f6b] max-[620px]:text-[0.72rem]">
                  {state.selectedWorkspace?.isGit
                    ? "Create an isolated branch workspace."
                    : "Available for git directories only."}
                </small>
              </span>
            </label>
          </div>
          <small className="font-mono text-[0.52rem] leading-[1.45] text-[#5d9168] max-[620px]:text-[0.72rem]">
            {state.modeHelp}
          </small>
        </fieldset>
      ) : null}
    </>
  );
}
