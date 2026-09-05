# Temporary Provider-Layer await→Effect Mapping

Exhaustive inventory: every `await` in `packages/infrastructure/src/agents/**`
(138 sites surveyed) mapped to its target Effect form. Implement top to bottom;
do not reorder phases. Read the referenced function bodies before editing —
this document gives dispositions, not copy-paste diffs.

## 0. Method

For each site, classify the callee, then apply exactly one rule:

- **Y (yield directly)**: callee already returns an Effect after this task's
  conversions. `await f(...)` becomes `yield* f(...)`.
- **L (leaf lift)**: callee is a foreign Promise/callback API that stays
  Promise (seams, test interception points, plugin/monitor contracts).
  `await f(...)` becomes `yield* fromPromise(() => f(...))`.
- **S (stays)**: the enclosing function keeps its async/Promise shape for a
  stated reason. No change.
- **G (gen body)**: an `async` function whose body mixes Y/L callees becomes
  `Effect.gen` (or stays an `Effect.fn` program) returning `ApplicationEffect`.
- **SYNC**: the called function is synchronous underneath its `async`
  keyword; drop `async`/`await` entirely and call it directly
  (`codexSessionFiles`, `collectCodexSessionBaseline`).

`new Promise` executors without cancel handles become `fromPromise` leaves.
Executors WITH release logic (sockets, timers with cleanup, abort
listeners) become `Effect.acquireUseRelease`. Sync code that can throw and
carries OUR validation stays behind `attemptSync`
(`packages/application/src/attempt.ts`); foreign throws (AbortError,
third-party, fs races) pass through raw — verified: `runPromise` rejects
defects with the thrown value intact, so boundary output is identical.

## 1. Ground rules (non-negotiable)

1. **Leaf-lift rule.** Lifting happens at most once per foreign call, at the
   innermost call site. Never `fromPromise` an already-Effect value. Never
   `runEffectAsPromise` mid-flow except the documented callback edges below.
2. **Soft values stay soft.** `undefined`/`false` returns on non-OK responses
   are CONTROL FLOW, not failures: `reconcile()` branches on
   `exists === false` vs unknown-status-keeps-state; `resolveSessionId`
   rethrows with context (port number, session name) the leaf does not have.
   Converting them to failures would delete the context or force restructuring
   for zero gain. Document the convention per method instead. What gets typed
   is the THROWN side (section 2).
3. **E carries unions exactly where callees are typed.** Provider leaves and
   their compositions declare precise `E` unions (section 2); compositions
   over `E=Error`-typed deps keep `E=Error`. Precision is recovered locally
   because `yield*` preserves inferred types inside the composing function —
   only the declared boundary widens.
2. **No behavior change in this task.** No new retries, no new throws, no new
   timeouts. Every `setTimeout` duration, poll interval, backoff formula,
   warn/observe event name, diagnostic counter, and dedup rule stays
   byte-identical in effect. Open behavior questions are listed in section 5;
   they are explicitly OUT of this task.
3. **Soft failures stay soft.** Several client methods encode failure as
   VALUES (`undefined`/`false`) on non-OK responses instead of throwing.
   Preserve each one exactly (table in 3A). Do not invent throws.
4. **Messages, codes, names, `_tag`s, `retryable` flags stay identical.**
   Add `_tag` to the five existing infra error classes (section 2). Do not
   add `code` to anything codeless (`mapError` default arm depends on it).
5. **E unions only inside the provider layer.** Provider leaves, their
   compositions, and the `AgentBackendProvider` port declare the precise
   unions from section 2. Application ports keep `E=Error` (widening at that
   boundary is automatic and harmless). Full static narrowing across
   application ports remains a separate project.
6. **Injected seams keep Promise signatures**: `OpenCodeRequest`,
   `spawn`/`probePort`/`allocatePort`/`sleep`/`wait` injectables,
   `CodexSessionStateRepository` fakes in tests stay working — EXCEPT
   `CodexSessionStateRepository` itself flips to Effect (section 3F) with its
   one test fake updated alongside.
7. Plugin/monitor/callback contracts stay Promise: `AgentPluginV1`,
   `AgentMonitor.start/stop/sink`, `AgentBackendLaunch.abortSession/dispose`,
   `SidecarSpec.health/stop`, `watchCodexSessionName` handle factory.

## 2. Shared new pieces

- `_tag` (additive, non-breaking) on: `OpenCodeStreamClosedError`,
  `OpenCodeRequestTimeoutError`, `OpenCodeResponseTooLargeError`,
  `OpenCodeRegistryLockTimeoutError`, `OpenCodeServerUnavailableError`.
  Values, messages, `code`, `retryable` untouched.
- Provider error unions (declared E on leaves and their compositions):
  - `OpenCodeClientError = OpenCodeRequestTimeoutError | OpenCodeResponseTooLargeError | OpenCodeStreamClosedError | OpenCodeTransportError`
  - `CodexRpcError = CodexSocketClosedError | CodexTransportError`
  - `OpenCodeTransportError { _tag, retryable = false }` wraps foreign fetch
    rejections with the message preserved verbatim (no `code`, so wire
    mapping is unchanged; `retryable: false` matches current effective
    display where the flag is absent).
  - `CodexTransportError { _tag, retryable = false }` wraps foreign socket
    failures the same way (replaces the inline
    `new Error("Codex app-server socket closed unexpectedly")`, same message).
  - `CodexSocketClosedError` is NOT introduced: the existing inline socket-
    closed error becomes `CodexTransportError` with the identical message.
- No other new error types. No `code` on anything codeless.
- Timing constants keep exact values; when a hand-rolled loop becomes a
  `Schedule`, encode the SAME formula:
  - monitor reconnect: `min(500 * 2^attempt, 10_000)` (`defaultReconnectDelay`)
  - jsonl poll 200ms, discovery retry 500ms, request timeout 5000ms,
    response cap 4MiB, watch poll 200ms / stop-race 250ms.
- `Effect.sleep` replaces module-level `sleep()` helpers inside gen bodies;
  keep the Promise `sleep` exports for the async loops that remain.

## 3. Per-file mapping

### 3A. `agents/opencode/client.ts` (~25 sites)

- `requestWithTimeout` (exported, tested in `client.test.ts`): convert to
  `Effect` via `Effect.acquireUseRelease` (timer + abort-listener acquire,
  clear/remove in release; `controller.abort()` in release, matching the
  `finally`). The inner `requestPromise` becomes `fromPromise` leaves
  (`request(...)`, `readResponseBody(...)`). Preserve: race order, timeout
  error value, abort-reason propagation, listener cleanup.
- `readResponseBody`, `safeJson`: gen bodies (`reader.read()` via
  `fromPromise` leaf; `reader.cancel()`/`releaseLock()` preserved in order;
  oversize throw becomes `Effect.fail`, same value).
- `OpenCodeClient` methods (`health`, `createSession`, `setSessionTitle`,
  `sessionExists`, `sessionStatus`, `abortSession`, `replyPermission`,
  `forkSession`, `requestWithTimeout` wrapper, `get`, `events` helpers):
  gen bodies yielding the above. **Soft-failure table (preserve exactly):**
  non-OK `health`/`createSession`/`sessionExists`/`sessionStatus`/
  `abortSession`/`replyPermission`/`forkSession` return
  `undefined`/`false` — keep as `Effect.succeed` values, never failures.
- `events(signal)` AsyncGenerator: convert the pull step to Effect and expose
  a `Stream` (`Stream.unwrap` + `Stream.repeatEffectOption`-shaped; exact
  combinator choice is the implementer's, but the stream must fail with
  `OpenCodeStreamClosedError` on close and propagate transport failures raw).
  `for await` consumers move to `Stream.runForEach`. `parseSseBlock`,
  `normalizeSsePayload`, `findEventBoundary`, `sessionStatusValue`,
  `objectValue`, `stringValue` are sync — untouched.

### 3B. `agents/opencode/server.ts` (manager lifecycle)

- `ensure`, `waitForHealth`, `readHealth`, `probePort`,
  `allocatePort`/`allocatePreferredPort`, registry read/write, lock acquire:
  gen bodies. `spawn`/`probePort`/`sleep`/`wait` injectables stay Promise
  (test seams) → `fromPromise` leaves at use. `sleepWithAbort` and the
  `Promise.race([wait, aborted])` pattern become `Effect.race` of sleep
  vs abort-watcher, preserving responsiveness and timeouts.
- `OpenCodeRegistryLockTimeoutError` / `OpenCodeServerUnavailableError`:
  add `_tag` only.
- `server.test.ts` fakes (`spawn`, `allocatePort`, sleeps) keep working
  unchanged because seams stay Promise.

### 3C. `agents/opencode/plugin.ts`

- `prepareLaunch` internals (`manager.ensure`, `resolveSessionId`,
  client calls): gen bodies (`yield*` after section 3A/3B
  conversions; `plugin.prepareLaunch` stays a `fromPromise` leaf as it is the
  extension port).
- The exported plugin object methods (`detect`, `launch`,
  `prepareLaunch`, monitors): STAY async (extension API contract), each a
  single bridge over the converted internals.
- `resolveSessionId`: gen body (client yields direct).

### 3D. `agents/opencode/monitor.ts` + `agents/provider-monitors.ts`

Redesign zone (stateful concurrent objects — convert bodies, keep shells):

- `OpenCodeMonitor.start/stop`: STAY async (port + abort-controller
  lifecycle). `runStream`/`backoffAndReconcile`/`reconcile`/`handleEvent`/
  `handlePermission`/`maybeWaitingInput`: gen bodies. `for await (event of
  stream)` consumes the 3A Stream. `sleep`s become `Effect.sleep` EXCEPT the
  reconnect backoff, which becomes a `Schedule` encoding
  `defaultReconnectDelay` exactly. `emit` stays (dedup rule + sink callback
  untouched; sink call via `fromPromise` leaf).
- `JsonlAgentMonitor` (`provider-monitors.ts`): `start`/`stop`/timer/
  reentrancy-guard/`poll` dispatch STAY exactly (unref'd timer semantics keep
  the process exitable). `pollFile`/`handleRecord`/`handleCodexRecord`/
  `handleClaudeRecord`/`emit`: gen bodies; `sink(...)` via `fromPromise`
  leaf. Dedup (`lastState`/`lastOutput`), offset bookkeeping, discovery
  retry timing, `readFileSync` silent-skip-on-throw: all preserved verbatim.
- `createCodexMonitor`/`createClaudeMonitor` factories: untouched.

### 3E. `agents/codex/*`

- `state.ts`: port + Drizzle impl → Effect (`attemptSync` around the sync
  drizzle chains, same values). Update `emptyCodexStateRepository` fake in
  `cli/backend.test.ts` to `Effect.succeed` returns.
- `remote-control.ts`: `openSocket` → `Effect.acquireRelease` (socket
  destroy in release, preserving close semantics); `readChunk`/
  `performHandshake`/`receiveMessage`/`readByte`/`readBytes`/`request`/
  `initialize`/`connect` → gen with `fromPromise` leaves around the raw
  socket executors. `onClose` handler error value verbatim.
- `session-discovery.ts`: `discover`/`filter`/`recover`/`repair`/`report` →
  gen. `deps.sessions.*` → direct `yield*`. `deps.state.*` → direct
  `yield*` (after state port flip). `deps.audit` → direct `yield*` (change
  `CodexSessionDeps.audit` to `ApplicationEffect<void>`; sole constructor
  is codex `codexDeps()`, pass `this.options.audit.record(...)` directly).
  `session.update(...)` → `attemptSync`. `ApplicationError` throw →
  `Effect.fail`, same value. `codexSessionFiles`/`collectCodexSessionBaseline`
  → SYNC (pure sync underneath; drop `async`). `codexSessionCandidates`,
  `codexSessionRoot`, `inspectCodexMeta`, `walkFiles`, `readCodexBaseline`
  untouched. `watchCodexSessionName` handle factory STAYS async; bridge the
  per-iteration Effect composition once per loop; 200ms/250ms constants kept.
- `codex/backend.ts`: all port methods → Effect bodies. `resolveCodexCommand`
  / `ensureCodexRemoteControl` / `session.update` via `attemptSync`.
  `manageRemoteOperation` (promise-chain mutex) STAYS async with its
  `state.find` bridged once; document why (ordering semantics).
  `codexDeps`: audit direct, `manageRemoteThread` stays Promise. Plugin
  launch builders untouched (sync).

### 3F. `agents/claude/backend.ts`, `agents/opencode/backend.ts`

- Port flip first (section 4 order), then: trivial methods → `Effect.succeed`
  values; `prepareLaunch`/`restoreLaunch`/`preparePluginLaunch` → gen with
  `fromPromise` leaves around plugin calls; `signal?.throwIfAborted()` stays
  RAW (foreign AbortError is wire-visible; do not rewrap); `session.update`
  / `resolve*Command` via `attemptSync`.

### 3G. `agents/backend.ts` (port) + `cli/backend.ts` call sites

- Flip the 8 `AgentBackendProvider` methods to `ApplicationEffect` (keep
  `signal?`, keep `abortSession`/`dispose` Promise fields — plugin-owned).
- `cli/backend.ts`: drop `fromPromise` around provider calls (direct
  `yield*`); `prepareLaunch` keeps its `fromPromise` thunk ONLY for the
  effect-signal linkage into `provider.prepareLaunch(signal ?? effectSignal)`
  — document this as the single intentional exception.
- `AgentMonitor`, `AgentPluginV1`, `SidecarSpec`, `AgentBackendLaunch`
  shapes: untouched.

### 3H. `agents/launch.ts` builders (codex/claude/opencode)

- Zero awaits today — verify with grep, change nothing.

## 4. Execution order (atomic components; gates after each)

1. C-opencode-client (3A leaves + `_tag`s) → gates.
2. C-opencode-server (3B) → gates.
3. C-opencode-rest (plugin internals, monitor, backend) → gates.
4. C-codex (state port+fake, remote-control, discovery, backend) → gates.
5. C-claude (backend) → gates.
6. C-port (provider flip + `cli/backend` call sites + `backend.test.ts`
   fake) → gates.
7. C-monitors (3D) last (most stateful) → gates.

Gate per component: `turbo run typecheck` 16/16 for affected packages,
affected `*.test.ts` files green, `biome check --write` on touched files
then `biome ci` clean, `test:table` if test files touched.

## 5. Open product decisions (BLOCKED on user verdict — do NOT implement,
## default to preservation)

- D1 (RESOLVED — no change): non-OK responses stay soft. Verified per call
  site: `reconcile()` branches on `exists === false` vs unknown-keeps-state;
  `resolveSessionId` rethrows with port/session context the leaf lacks;
  `health()` unknown is a normal outcome. Throwing would delete context or
  restructure control flow for zero gain. 429/422 distinction stays out for
  the same reason.
- D2 (OPEN): enabling retries is new behavior, not refactoring. Candidates
  once E unions exist: remote thread RPC on `CodexTransportError`, monitor
  `sessionExists`/`sessionStatus` polls on `OpenCodeTransportError`,
  `waitForHealth` probes. For each: max attempts, backoff budget, and whether
  user-visible timing may change. No retries are added in this task.
- D3 (OPEN): `retryable` refinement for the two transport wrappers (allowlist
  `ECONNREFUSED`/`ECONNRESET`/`ETIMEDOUT`/`EPIPE`/`UND_ERR_*` like the CLI
  `isConnectionError` precedent vs default-false)? Web displays the flag;
  changing defaults changes UI. Wrappers default to `retryable = false`,
  matching current effective display where the flag is absent.
- D4: `watchCodexSessionName` 200/250ms and monitor poll intervals are
  behavior; keep exact values in any Schedule conversion.

## 6. Full verify (same as work instruction section 6)

typecheck 16/16, architecture valid, table rules pass, `test:local`
934+ pass (only environmental web-daemon failure), web vitest 219/219
(`--pool=threads` under sandbox), build 9/9, audit clean, biome clean
except pre-existing html. No commits/PRs. Report per component.
