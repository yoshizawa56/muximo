# Issue #100: View/ViewModel Boundary Worklist

Issue: https://github.com/yoshizawa56/muximo/issues/100

This worklist tracks the View/ViewModel boundary review for the pane route and
its directly related Web UI modules. Check an item only after the file has been
reviewed, changed or deliberately left unchanged, and the reason is recorded
in the implementation notes below.

## Working definition

- A View owns presentation-local state and transitions: tabs, modal visibility,
  drag and hover state, focus, transient drafts, and similar state with no
  business meaning, persistence, shared consumers, or external effects.
- A ViewModel owns application semantics and coordination: server, shared, and
  persisted state; route and resource selection; terminal transport; external
  effects; and intent-oriented commands.
- The ViewModel interface is the View's scenario boundary. It should provide a
  complete, deterministic fixture without requiring the View to know how data
  was obtained or how an intent is implemented.
- Stories enumerate meaningful ViewModel scenarios, not every possible
  field-value combination. A scenario is warranted when ViewModel output
  creates a distinct View branch or user-visible state.
- Storybook `play` functions exercise real View-local transitions. Pure
  policies and transforms, terminal schedulers, storage migrations, and
  external transport or bridge behavior remain covered by focused tests.

## Work stages

### Inventory and baseline

- [x] Record the Issue #100 boundary and Story strategy.
- [x] Inventory the pane route, its direct consumers, and supporting modules.
- [x] Run the relevant baseline tests, lint, and typecheck before implementation.
- [x] Record any pre-existing failures before changing behavior.

### Page composition and primary ViewModels

- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-control-room/viewmodel.ts`
  — review the composition root, route/resource coordination, shared keyboard
  modifiers, and intent-oriented child ViewModel interfaces.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-control-room/view.tsx`
  — keep presentation derivation and local UI behavior in the View; split
  independently meaningful page sections when that improves the boundary.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-control-room/stories.tsx`
  — replace ad hoc fixtures with a typed, named ViewModel scenario catalog and
  executable page stories.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/index.tsx`
  — verify that the route adapter only connects router state to the page
  ViewModel and View.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-pane-board/viewmodel.ts`
  — separate server/query and selection semantics from presentation-only open
  state if the review confirms that split.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-pane-board/viewmodel.test.ts`
  — preserve or update focused tests for pane-board policies and commands.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-pane-board/view.tsx`
  — render the board from the revised contract and exercise its local overlay
  behavior through stories.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/viewmodel.ts`
  — keep terminal lifecycle and transport coordination in the ViewModel while
  identifying pure policies or protocol transforms that should be extracted.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/viewmodel.test.ts`
  — update focused behavior tests when the terminal ViewModel contract changes.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/viewmodel.ts`
  — keep persisted keyboard configuration and terminal/native intents in the
  ViewModel; keep settings visibility and other presentation-only state in the
  View layer.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/viewmodel.test.ts`
  — update semantic and persistence behavior tests for the revised contract.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/view.tsx`
  — preserve local editor state in the View; the existing keyboard and settings
  sections are meaningful boundaries, so no line-count-only split is required.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/view.stories.tsx`
  — make the story harness stateful where `play` interactions need changing
  ViewModel output; cover editor, drag, draft, and keyboard interactions.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-shell/view.tsx`
  — review this composition/story host and either align it with the boundary
  or remove its responsibility if the page View becomes the single host.

### Directly related presentation and resource modules

- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-waiting-notification/controller.ts`
  — verify that notification transitions and timers remain presentation
  behavior derived from ViewModel data.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-waiting-notification/patterns.tsx`
  — verify local animation, swipe, expansion, and dismissal state.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/-pane-layout-overlay-view.tsx`
  — verify that window selection, focus management, and overlay interaction
  remain local View behavior.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/-pane-layout-overlay-view.test.ts`
  — preserve focused tests for pure overlay geometry and interaction helpers.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/-session-view.tsx`
  — verify the shared `PaneLayoutOverlay` consumer after any contract change.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/-session-view.stories.tsx`
  — update shared overlay scenarios if its contract or behavior changes.
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/-pane-state.ts`
  — verify that pane labels remain a pure presentation transform.
- [x] `apps/web/src/routes/terminals/-terminal-resources.ts`
  — verify the shared server-state/resource boundary used by the page
  ViewModel; do not duplicate query ownership while refactoring.
- [x] `apps/web/src/routes/terminals/-story-fixtures.ts`
  — extend or reorganize shared fixtures only when the new scenario catalog
  needs stable pane/session data.
- [x] `apps/web/src/platform/muximo-bridge.ts`
  — verify that browser bridge effects stay behind ViewModel intent callbacks.

### Existing extracted policies and transport helpers

These files are included to prevent accidental reabsorption of pure or
infrastructure-facing behavior into a View during the refactor. Change them
only when a contract or extraction is actually required.

- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/flick.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/flick.test.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/input.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/input.test.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/layout.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/storage.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/storage.test.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/terminal-actions.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/terminal-actions.test.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-custom-keyboard/policy.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/policy.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/font.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/font.test.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/scheduler.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/scheduler.test.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/touch.ts`
- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/touch.test.ts`

### Candidate files to add if the boundary requires them

- [x] `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-pane-board/view.stories.tsx`
  — add a dedicated board story when page stories cannot express the board's
  loading, error, selection, and overlay interactions clearly.
- [x] A dedicated terminal View and story module — reviewed and intentionally
  deferred because the current terminal surface is the xterm/transport host;
  extracting a View without moving lifecycle code would not improve the seam.
- [x] Dedicated custom-keyboard View modules — reviewed and intentionally
  deferred because `CustomKeyboardView` and `CustomKeyboardSettingsView` already
  provide meaningful in-file boundaries; no line-count-only split is needed.

### Final verification

- [x] Every meaningful ViewModel output branch has a named Story or an explicit
  reason it is covered by an existing scenario. Control-room Stories cover
  connection, pane, viewport, paste, shell, and keyboard states; pure and
  transport-only branches remain in focused tests.
- [x] Every user-visible, deterministic View-local state transition has a
  Storybook `play` path. Platform-dependent pointer coordinates and transient
  drag geometry remain covered by the existing drag policy and input tests.
- [x] Pure policy and transform tests remain table-driven and focused.
- [x] Terminal, storage, browser bridge, and query behavior retain focused
  tests at their external boundaries.
- [x] Run lint, typecheck, and relevant tests.
- [x] Run the Storybook build with `STORYBOOK_DISABLE_TELEMETRY=1`.
- [x] Review the final diff against this worklist and record intentional
  no-change decisions.

## Implementation notes

### Initial observations

- `ControlRoomViewModel` is primarily a composition root, but it also owns
  route/resource selection, a duplicated panes query, shared keyboard modifier
  state, terminal behavior, and pane-board composition.
- `PaneViewModel` contains terminal/xterm/WebSocket lifecycle. Its pure
  protocol and state policies now live in `-terminal/policy.ts` and remain
  independently testable.
- `CustomKeyboardViewModel` now exposes persisted keyboard configuration and
  terminal/native intents; settings visibility and close/save transitions are
  owned by the consuming View.
- `PaneBoardViewModel` now owns the panes query and selected-target derivation;
  its presentation-only open state is owned by the page View.
- `ControlRoomView` and `CustomKeyboardSettingsView` already contain useful
  presentation boundaries. Any component split should follow behavior and
  ownership, not file length alone.
- `PaneLayoutOverlay` and the waiting-notification patterns already keep most
  focus, tab, animation, swipe, and dismissal behavior in the View layer.

### Baseline results

- `bun run test:table` passed for 101 files.
- `apps/web` tests passed: 24 files and 197 tests.
- `apps/web` typecheck passed.
- `bun install --frozen-lockfile` installed the dependencies but its
  repository `lefthook install` prepare step could not replace the shared
  worktree hook at `/Users/toru_yoshizawa/work/muximo/.git/hooks/pre-commit`.
  No hook files were changed by this work.

### Current implementation progress

- Moved pane-board open/close/toggle state from `PaneBoardViewModel` into the
  page View and made pane selection navigate with the stable route `paneId`.
- Removed the duplicate panes query from `ControlRoomViewModel`; the
  pane-board ViewModel now owns the panes query and derives the selected host
  target for terminal transport.
- Moved custom-keyboard settings visibility and close/save transitions out of
  the custom-keyboard and control-room ViewModels into `ControlRoomView` and
  `ShellView`.
- Extracted React- and I/O-independent custom-keyboard policies into
  `-custom-keyboard/policy.ts`, while keeping persisted-state parsing and
  storage effects in the ViewModel boundary.
- Extracted terminal protocol/state policies into `-terminal/policy.ts`, while
  keeping xterm, WebSocket, and browser-bridge lifecycle in the ViewModel.
- Added named control-room scenarios for idle, waiting, connecting, closed,
  shell, desktop ownership, connection error, action error, all image-paste
  states, standard-keyboard visibility, loading, pane-list error, and empty
  pane states, plus a dedicated pane-board story.
- Added `play` coverage for pane-map, keyboard-settings, modifier, flick-repeat,
  shift, shortcut-editor, and standard-keyboard local state transitions.
- Reviewed the terminal View boundary and intentionally kept the current
  terminal surface together because its DOM host and transport lifecycle are
  coupled; no standalone terminal View/story module was added.

### Verification after the first boundary pass

- `apps/web` typecheck passed.
- `apps/web` tests passed: 24 files and 199 tests.
- `bun run test:table` passed for 101 files.
- `bun run lint` passed with two pre-existing warnings in
  `docs/logo-exploration.html`.
- `git diff --check` passed.
- `bun run check:architecture` passed.
- `STORYBOOK_DISABLE_TELEMETRY=1 bun run build-storybook` passed. Storybook
  reported the existing absence of `src/**/*.mdx` files and a chunk-size
  warning; neither prevented the build.
