# Shell Stability Audit

Date: 2026-08-31

## Executive summary

The shell experience is unstable because viewport ownership, terminal geometry,
transport recovery, mobile keyboard visibility, and tmux reconciliation are
implemented as separate event-driven mechanisms without one authoritative
state model. Several current transitions actively work against each other.

The highest-impact issues are:

1. A browser `resize` frame implicitly claims mobile ownership. Rendering the
   desktop-ownership notice changes the terminal container height, which can
   send a resize and immediately take ownership back from the desktop. This
   can also happen while the native app is backgrounded: the desktop-owner
   event still updates the hidden WebView, and any delivered or deferred
   `ResizeObserver` callback can reclaim the viewport without mobile input.
2. PTY output produced while the WebSocket is parked is discarded. A resumed
   xterm therefore continues from an incomplete ANSI byte stream.
3. Input entered while disconnected is retained without a bound and replayed
   after reconnect, when the shell may be in a different state.
4. The desktop takeover path assumes `client-active` represents desktop input.
   tmux defines it as the client becoming the latest active client of its
   session, so repeated input from an already-active desktop client does not
   provide the required signal.
5. Mobile keyboard state and app viewport height use independent heuristics.
   Recovery stops after 600 ms and native keyboard lifecycle events are not
   used, so a late WKWebView viewport update can leave the app permanently
   short.
6. Terminal output ignores WebSocket backpressure, while a synchronous tmux
   polling command runs every 250 ms on the daemon event loop.

The recommended order is to fix ownership semantics first, then make terminal
resume loss-aware, then replace the reconnect and keyboard heuristics with
explicit controllers. The current alpha compatibility policy makes it
preferable to replace the protocol semantics directly instead of retaining the
implicit resize-as-claim behavior.

## Current data flow

```text
VisualViewport / ResizeObserver
  -> FitAddon.fit()
  -> coalesced WebSocket resize control frame (geometry only)
  -> TerminalSession
  -> PTY resize; tmux resize only while mobile owns the viewport

Desktop tmux client
  -> tmux hook through curl, or 250 ms polling fallback
  -> claimDesktop()
  -> WebSocket viewport event
  -> React renders desktop ownership notice as an overlay
  -> terminal geometry remains stable
  -> a background/deferred ResizeObserver callback records geometry only
  -> explicit mobile input or Take control sends claim(cols, rows)
```

Both sequences describe the implemented separation between geometry and
ownership. Geometry observation must not be an ownership intent.

## Findings

### P0: Resize and ownership are conflated

Evidence:

- `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/viewmodel.ts:484`
  fits the xterm and sends a `resize` for any container resize.
- The same file registers both a `ResizeObserver` and `terminal.onResize`, so a
  single fit can send duplicate control frames (`:749` and `:762`).
- `packages/muximod/src/http/terminal-session.ts:264` handles `resize` by
  calling `claimMobile(message.cols, message.rows)` before resizing the PTY.
- `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-control-room/view.tsx:300`
  conditionally inserts a desktop-ownership notice into the same flex column as
  the terminal. The notice itself changes terminal geometry.
- App lifecycle handling in `viewmodel.ts` reconnects on foreground, but it
  does not suspend resize transmission or release ownership on background.
  The mounted terminal keeps its WebSocket, `ResizeObserver`, and window resize
  listener until the route unmounts.
- `packages/muximod/src/http/terminal-session.ts:325` also claims mobile
  ownership unconditionally during a transport resume.

Impact:

- Desktop ownership can be immediately reverted without mobile input.
- Keyboard animation, browser chrome changes, font loading, notices, and modal
  layout changes become ownership changes.
- Repeated resize frames execute multiple synchronous tmux processes and full
  redraws.
- A background phone can resize a window currently being used on the desktop,
  even without reconnecting or receiving mobile input. Whether the takeover is
  immediate or delayed depends on WebView background scheduling, which makes
  the symptom intermittent.

Recommendation:

- Change `resize` to update the stored mobile geometry only. It must never
  transfer ownership.
- Make `claim` the only explicit ownership transfer and include the latest
  `{ cols, rows }` in the claim so it applies one coherent state.
- Treat actual terminal input as an explicit mobile claim, as today.
- Preserve the existing owner on transport resume. Send the authoritative owner
  in `ready` or in an immediately following `viewport` snapshot.
- Gate terminal geometry publication by app lifecycle. Geometry measured while
  backgrounded may be stored locally, but it must not claim ownership or resize
  the shared tmux window. Foreground reconciliation must first read the current
  owner and preserve desktop ownership until explicit mobile interaction.
- Keep the desktop notice as an overlay, or reserve stable space for status UI,
  so status rendering does not resize xterm. This is defense in depth, not the
  ownership fix.
- Use one resize path: fit immediately for local rendering, coalesce terminal
  dimensions, send only changed dimensions after a short trailing debounce, and
  remove the duplicate network send from either `sendResize` or `onResize`.

Required regression cases:

- desktop claim -> browser container resize -> owner remains desktop;
- desktop claim -> ownership notice appears -> owner remains desktop;
- desktop claim while the mobile app is backgrounded -> owner remains desktop
  before and after the app returns to foreground;
- a deferred hidden-WebView resize callback -> geometry may update, owner
  remains desktop;
- desktop claim -> mobile input or explicit Take control -> owner becomes mobile;
- reconnect while desktop owns -> owner and desktop dimensions are preserved;
- repeated equivalent geometry observations produce no tmux command.

### P0: Resumed transport is not a resumed screen

Evidence:

- `packages/muximod/src/http/terminal-session.ts:511` sends PTY output only when
  a socket is open. Output is silently discarded while the session is parked.
- `packages/muximod/src/http/terminal-session.ts:549` parks the PTY and viewport
  for 30 seconds, but no output journal or redraw marker is maintained.
- `packages/muximod/src/http/terminal-session.ts:325` resumes the socket and
  sends `ready`, but does not replay missed output or force an authoritative
  tmux redraw.
- Existing resume tests emit output only after the replacement socket is
  connected. They do not cover output produced during the gap.

Impact:

- ANSI cursor movement, alternate-screen updates, erases, and wrapped output
  may be partially missing after reconnect.
- TUI applications can remain visually corrupt even though the status says
  connected.

Recommendation:

- Maintain a bounded raw-byte gap buffer while a resumable session is parked.
- If all missed bytes fit, replay them in order before declaring the terminal
  fully synchronized.
- If the buffer overflows or WebSocket backpressure drops output, mark the
  screen dirty and force a tmux full-client refresh after the new transport is
  bound. Reset xterm before applying the authoritative redraw when necessary.
- Keep explicit bounds by bytes and time. Do not persist terminal output.
- Preserve PTY bytes as `Uint8Array` through the infrastructure boundary rather
  than decoding and re-encoding them before transport.

Required regression cases:

- output during a short disconnect is replayed exactly once and in order;
- overflow causes one full redraw rather than partial replay;
- no terminal bytes, resume tokens, or ticket URLs appear in logs;
- output ordering relative to `ready` is deterministic and input is not enabled
  until synchronization is complete.

### P0: Disconnected input can execute later

Evidence:

- `apps/web/src/routes/terminals/$terminalId/sessions/$sessionName/panes/$paneId/-terminal/scheduler.ts:167`
  stores all input while detached with no byte, item, or time bound.
- `viewmodel.ts:641` detaches that queue on socket close without clearing it.
- `viewmodel.ts:570` flushes the retained input immediately after a later
  `ready`, including after fallback from an expired resume to a fresh attach.

Impact:

- Keystrokes, Enter, or control sequences entered during an outage can run
  seconds later in a different prompt or application state.
- A long outage can grow browser memory without a bound.

Recommendation:

- Do not queue interactive terminal input across an established transport loss.
- Allow only a small, bounded pre-ready queue for the initial connection, or
  remove pre-ready input entirely.
- Disable custom and native terminal input while reconnecting and show a clear
  reconnecting state. If queued-input UX is ever added, it must be visible and
  explicitly cancellable.
- Observe client `WebSocket.bufferedAmount`; stop accepting input and reconnect
  when the pending amount exceeds a small threshold.

### P1: Reconnect has terminal states that look like progress

Evidence:

- `viewmodel.ts:471` stops automatic retries after eight attempts.
- A close-only failure can remain in `connecting` with no error message once the
  attempt limit is reached.
- `openMuximodTerminal()` has no ticket timeout, WebSocket-open timeout, attach
  timeout, abort signal, or stale-attempt guard while ticket creation is pending.
- There is no `online` listener or transport watchdog. Native foregrounding
  starts another reconnect but does not model whether an earlier attempt is
  still pending.
- The server grace period is 30 seconds, while the retry schedule reaches an
  attempt after that window. The fallback silently creates a fresh attach.

Recommendation:

- Extract a terminal connection controller with explicit states:
  `ticketing`, `opening`, `attaching`, `synchronizing`, `connected`,
  `reconnect_wait`, `offline`, `stalled`, and `closed`.
- Give every attempt a generation and one cancellation scope. Stale ticket and
  socket results must not replace a newer attempt.
- Add bounded ticket, open, attach, heartbeat, and synchronization deadlines.
- Retry indefinitely while the route remains active, with capped exponential
  backoff and full jitter. `online`, foreground, and user retry should trigger
  an immediate attempt without creating parallel attempts.
- Align the server resume window with the mobile outage policy. A longer
  bounded grace period is reasonable if per-device parked-session count,
  output-buffer bytes, and expiry are capped.
- Report retry attempt and next action in the UI instead of a permanent generic
  spinner.

### P1: Full reload cannot replace the parked session cleanly

Evidence:

- Resume credentials intentionally live only in module memory
  (`viewmodel.ts:43`), so a document reload starts a fresh attach.
- A lost old document parks its session for 30 seconds.
- `TerminalSessionRegistry.releaseParkedForDifferentTarget()` releases a parked
  session only when its target differs. A fresh attach for the same target
  continues to hit the viewport lease conflict until expiry.

Recommendation:

- Keep resume tokens out of persistent browser storage.
- Define an explicit, authenticated replacement rule: a fresh attach from the
  same authenticated device may replace its parked lease for the same target.
- For an active competing client, return a typed `terminal_in_use` result and
  require an explicit takeover instead of retrying an opaque attach failure.
- Rotate the resume token on every successful resume, as today.

### P1: Desktop input detection uses the wrong tmux signal

Evidence:

- `packages/infrastructure/src/terminal/viewport-manager.ts:183` treats a
  focused `client-active` hook as desktop takeover.
- tmux defines `client-active` as a client becoming the latest active client of
  its session, not as every key press.
- The polling fallback intentionally ignores `client_activity` and only reacts
  to focus, size, or layout changes (`viewport-manager.ts:564`). An already
  focused desktop client can therefore type without any detected transition.
- Hook registration and delivery failures are swallowed. The UI still promises
  that PC activity hands the viewport back automatically.

Recommendation:

- Prototype tmux `window-size latest` first. tmux documents this mode as sizing
  the window from the most recently used client, including typing. It may
  eliminate manual size ownership and the fragile input inference entirely.
- Test the pinned tmux 3.6a behavior with grouped sessions, different client
  sizes, zoom, focus transitions, full-screen applications, and disconnects
  before adopting it.
- If manual ownership remains necessary, compare monotonic per-client activity
  and use a guarded debounce to distinguish real desktop use from muximod's own
  reconciliation. Do not call `client-active` an input hook.
- Report hook installation and delivery health. Use polling as a slower,
  observable reconciliation fallback rather than a silent 250 ms hot loop.
- Keep layout ownership and size ownership separate. tmux may be allowed to own
  size even if Muximo still coordinates zoom and selected pane state.

### P1: Keyboard and viewport recovery have two competing heuristics

Evidence:

- `apps/web/src/app/mobile-viewport.ts` owns app height from
  `VisualViewport.height` and uses fixed 120/300/600 ms recovery timers.
- `viewmodel.ts:373` independently infers keyboard visibility from focus and a
  separate height baseline.
- A helper textarea focus immediately sets the keyboard to visible even when a
  hardware keyboard is used and no viewport resize follows.
- Neither path uses native keyboard show/hide events. `@capacitor/keyboard` is
  not installed or configured.
- App foreground, `pageshow`, and orientation settlement do not explicitly
  reconcile app height.
- Visual viewport offset is ignored, so a panned WKWebView can have the correct
  height but the wrong visible origin.
- `interactive-widget=resizes-content`, dynamic viewport units, native WebView
  resizing, and the JavaScript visual-viewport height all participate without
  one declared owner.

Recommendation:

- Introduce one app-level viewport controller and expose a snapshot such as
  `{ height, offsetTop, keyboardPhase, source, settled }`.
- In Capacitor builds, install `@capacitor/keyboard`, choose and document one
  explicit iOS resize mode, and use `keyboardWillShow`, `keyboardDidShow`,
  `keyboardWillHide`, and `keyboardDidHide` as authoritative lifecycle hints.
- On the web, use VisualViewport as a fallback and settle after actual geometry
  stability or `scrollend`; do not stop recovery solely because 600 ms elapsed.
- Reconcile on app activation, `pageshow`, orientation change, window resize,
  visual viewport resize/scroll, and keyboard hide completion.
- Model `opening`, `visible`, `closing`, and `hidden`; focus means intent to open,
  not proof that the software keyboard is visible.
- Make xterm sizing consume the settled app geometry and send only the final
  terminal dimensions to the server.

Required matrix:

- native iPhone and iPad, supported iOS minimum through current;
- software keyboard show/hide using the toolbar button and system Done action;
- hardware keyboard attached;
- rotation while open and while closing;
- background/foreground in every keyboard phase;
- Safari/PWA and Capacitor WKWebView;
- split/floating iPad keyboard where supported.

### P1: Backpressure and daemon event-loop blocking are unhandled

Evidence:

- `packages/infrastructure/src/http/socket.ts:47` discards the numeric result of
  Bun `ServerWebSocket.send()`.
- `packages/muximod/src/http/ws-terminal.ts` has no `drain` or `error` handler
  and explicitly sets `idleTimeout: 0`.
- Bun documents `send()` results for sent, queued-under-backpressure, and dropped
  messages, but TerminalSession cannot observe any of them.
- Browser `WebSocket.bufferedAmount` is never checked.
- `TmuxViewportManager` polls every 250 ms and `TmuxAdapter` uses `spawnSync` for
  each tmux command. These commands share the daemon event loop with terminal
  WebSocket processing.
- The browser output scheduler can accumulate an unbounded array while a
  background tab is throttled.

Recommendation:

- Return send status through `MuximodSocket`, handle Bun `drain`, configure an
  explicit backpressure limit, and mark the terminal screen dirty when output
  is dropped.
- Add a bounded server output queue and a bounded browser output queue. A limit
  breach must switch to full-redraw recovery, not retain unbounded ANSI deltas.
- Add a finite idle/liveness policy. Preserve idle shells with protocol
  heartbeat or Bun ping configuration, but detect a half-open route in bounded
  time.
- Move recurring tmux observation off synchronous hot paths, serialize
  reconciliation per window, and coalesce redundant snapshot/resize/refresh
  commands.
- Prefer hooks plus a slow health reconciliation pass, or an async/long-lived
  tmux observation mechanism, over four synchronous child processes per second.

### P2: Terminal lifecycle is effectively unobservable

Evidence:

- TerminalSession, WebSocket backpressure, viewport ownership transitions, hook
  health, reconnect attempts, and viewport settlement have no structured
  operational events.
- Most tmux reconciliation errors are swallowed as best effort.
- Existing tests cover protocol helpers and server resume basics, but there is
  no browser-level transport lifecycle harness and no test for
  `mobile-viewport.ts`.

Recommendation:

- Add secret-free structured events for connection generation, phase duration,
  resume outcome, parked duration, gap-buffer bytes/overflow, send
  backpressure/drop, owner transitions, terminal dimensions, tmux command
  duration/failure category, hook health, and viewport source/settlement.
- Never log access tokens, tickets, resume tokens, terminal bytes, pasted image
  bytes, or URLs containing credentials.
- Add a deterministic browser transport harness with a fake WebSocket, clock,
  ResizeObserver, VisualViewport, app lifecycle, and xterm adapter.
- Add real isolated-tmux integration scenarios for multiple clients and fault
  injection around hooks, resize, zoom, and daemon restart.

## Proposed architecture

Keep the responsibilities within the existing boundaries:

- `apps/web` route ViewModel owns terminal connection coordination and exposes
  intent-oriented commands and observable connection state to the View.
- A shared app-level browser/native viewport adapter owns platform geometry and
  keyboard lifecycle. The terminal ViewModel consumes its snapshot; it does not
  duplicate keyboard inference.
- `packages/contract` owns the revised resize/claim, heartbeat, ready/sync, and
  typed failure frames.
- `packages/muximod` owns authenticated WebSocket session state, resume policy,
  synchronization, and bounded transport buffers.
- `packages/infrastructure` owns Bun socket backpressure, PTY bytes, and tmux
  observation/reconciliation.
- The composition root injects timing, limits, logger, and the concrete viewport
  adapter. Authentication remains endpoint-ticket based and tokens remain
  non-persistent.

Suggested protocol shape:

```text
attach { target, cols, rows, optional resume credentials }
resize { cols, rows }                  # geometry only
claim  { cols, rows, reason: "input" | "explicit" | "foreground" }
ping   { nonce }
pong   { nonce }

ready {
  session identity and rotated resume token,
  owner,
  cols,
  rows,
  sync: "replay" | "redraw"
}
synced { generation }
```

`claim.reason` is operational context, not authorization. Every frame remains
inside the authenticated, one-use-ticket WebSocket boundary.

## Delivery plan

### Phase 1: Stop ownership feedback

- Separate resize from claim in contract, server, viewport port, and web client.
- Preserve desktop ownership across resize and resume.
- Deduplicate and debounce terminal dimension messages.
- Add owner/resize integration tests.
- Make the desktop notice layout-stable.

This is the first release candidate because it directly addresses the reported
desktop-size failure and reduces tmux churn.

### Phase 2: Make recovery screen-safe and input-safe

- Add bounded parked-output replay with redraw fallback.
- Drop or visibly gate input during transport loss.
- Add same-device parked-session replacement for full reload.
- Align resume grace, retry, and resource limits.
- Add fault-injection tests for disconnects at every handshake phase.

### Phase 3: Replace reconnect heuristics

- Add the explicit connection controller, timeouts, jitter, online/foreground
  triggers, heartbeat, and stale-attempt cancellation.
- Surface useful reconnect state in the UI.
- Wire Bun and browser backpressure into dirty-screen recovery.

### Phase 4: Make mobile viewport deterministic

- Add the native Keyboard plugin and one documented resize policy.
- Introduce the unified viewport controller and web fallback.
- Test real device lifecycle and orientation sequences.
- Remove the fixed-delay and focus-equals-visible heuristics.

### Phase 5: Simplify tmux ownership and improve observability

- Run a focused `window-size latest` spike on pinned tmux 3.6a.
- Separate size, zoom, and pane-selection ownership.
- Remove or slow the synchronous polling hot loop.
- Add lifecycle metrics and a terminal diagnostics view/command that contains no
  terminal content or credentials.

## Acceptance criteria

- A desktop key press returns the shared window to desktop dimensions and it
  stays there until explicit mobile interaction.
- A backgrounded mobile app cannot reclaim or resize a desktop-owned window,
  including when hidden-WebView callbacks are delivered late.
- Closing the software keyboard always restores the app and terminal height
  without reopening the route.
- A network interruption shorter than the configured resume window produces a
  visually correct terminal after recovery.
- Input entered while disconnected never executes later without explicit user
  confirmation.
- Reloading the web document can replace its own parked terminal without waiting
  for grace expiry.
- A half-open or stalled connection becomes observable and retries in bounded
  time.
- Resize storms, output floods, hidden tabs, and slow clients have explicit
  memory and backpressure bounds.
- Terminal diagnostics can identify the failed phase without logging terminal
  bytes or credentials.

## Implemented in this worktree

The `codex/shell-stability-audit` worktree now contains the first stability
release candidate from the delivery plan:

- `resize` records mobile geometry only; `claim` is the explicit ownership
  transfer and includes dimensions. Resume preserves the current owner.
- `ready` reports `owner` and `sync`, and the desktop-owner notice is rendered
  as an overlay so it does not resize the terminal surface.
- Parked PTY output has a bounded byte gap buffer with replay or authoritative
  redraw fallback. Bun send status is observed; dropped/backpressured output
  parks the session for redraw recovery.
- Interactive input is bounded before the first attach and dropped after an
  established transport disconnect. Browser output is bounded and requests a
  `redraw` when its queue overflows.
- Same-device fresh attaches can replace that device's parked session without
  waiting for the grace timer; sessions without an authenticated device id
  still fail closed on same-target conflicts.
- Terminal connections have capped exponential retry, online/foreground
  triggers, cancellation-aware ticketing, WebSocket-open and attach deadlines,
  stale-attempt guards, and an application heartbeat.
- Mobile viewport recovery settles on actual animation-frame stability and
  reconciles after visibility, pageshow, orientation, and app foreground
  transitions instead of relying on fixed recovery delays.

Native keyboard plugin integration, a full browser transport harness, tmux
`window-size latest` evaluation, and structured diagnostics remain follow-up
work for the later delivery phases.

## External references

- tmux manual: hooks and `window-size latest` behavior
  (<https://man7.org/linux/man-pages/man1/tmux.1.html>)
- tmux advanced-use guide: `latest` uses the most recently used client, for
  example after typing
  (<https://github.com/tmux/tmux/wiki/Advanced-Use>)
- Capacitor Keyboard API: native show/hide lifecycle and resize modes
  (<https://capacitorjs.com/docs/apis/keyboard>)
- MDN VisualViewport: keyboard changes the visual viewport independently of the
  layout viewport
  (<https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport>)
- MDN WebSocket `bufferedAmount`
  (<https://developer.mozilla.org/en-US/docs/Web/API/WebSocket/bufferedAmount>)
- Bun server WebSocket backpressure and drain handling
  (<https://bun.sh/docs/runtime/http/websockets>)
