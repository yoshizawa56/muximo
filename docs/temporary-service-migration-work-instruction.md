# Temporary Service-Migration Work Instruction

For a follow-up agent taking the Effect migration to full Context.Service form.
Read this whole document before touching code. Do not skip the invariants:
most of the cost of this project is rework from guessing.

## 0. Starting state

- Worktree: `.worktrees/effect-evaluation`, branch `codex/effect-evaluation`.
- Base commit: `07300ff` (`fix: make agent execution CLI-owned (#117)`).
- Starting tree state: verify first — the tree MUST satisfy the gate below
  before you start. If it does not, stop and report instead of fixing
  unrelated breakage.

```sh
git status --short
node node_modules/turbo/bin/turbo run typecheck
```

Gate: `git status` shows only the files you intend to work on, and typecheck
reports `16 successful, 16 total`.

Background you must know (decisions already made, do not relitigate):

- Effect v4 beta (`effect@4.0.0-beta.107`). The beta API differs from Effect v3
  and from online docs. Section 7 lists what exists and what does not.
- Ports are TypeScript interfaces returning `ApplicationEffect`
  (`Effect<A, Error, never>`). Some areas already use Context services;
  see `packages/application/src/usecases/terminals/terminal-services.ts` (the
  normative pattern) and `packages/application/src/effect-runtime.ts`.
- Promise interop helpers live in `packages/infrastructure/src/effect.ts`
  (`fromPromise`, `runEffectAsPromise`, `normalizeError`). Application owns
  only the `ApplicationEffect` vocabulary type. Do not move them back.
- Failure taxonomy: every failure value carries `_tag` (plus stable `code`
  and `message` where it already had them). `packages/muximod/src/http/middleware.ts`
  `mapError` maps codes to the wire and MUST NOT be changed.
- `packages/application/src/attempt.ts` `attemptSync` converts sync throws
  (entity validation, id constructors, name normalization) into typed failures
  inside Effect programs. Use it; do not add new sync-throw paths in gens.

## 1. Mission

Convert every application port interface into a Context.Service Tag, convert
all usecases to consume Tags via `yield*`, convert all infrastructure adapters
into Layers, assemble Layers only in composition roots, and migrate all tests
to provide Layers. End state: no manually-wired dependency objects anywhere;
`Promise` appears only at the boundary positions listed in section 4.

Definition of done (all must hold):

1. `turbo run typecheck`: 16/16.
2. `bun run check:architecture`: valid.
3. `bun run test:table`: passes for every file.
4. `bun run test:local`: 934+ pass; the ONLY allowed failure is
   `Web daemon lifecycle > starts reuses and stops one Web process`, which
   fails with EPERM on process-group kill inside sandboxes (environmental;
   the files are byte-identical to base).
5. `apps/web` vitest: 219/219 (use `--pool=threads` if the forks pool fails
   to terminate workers with EPERM in a sandbox).
6. `turbo run build`: 9/9. `bun run audit:public`: clean.
7. `bunx biome ci .`: clean except the pre-existing
   `docs/logo-exploration.html` warnings (that file is unmodified vs base;
   do not touch it).
8. `grep -rn "new Error(" packages/application/src` (excluding tests and
   `attempt.ts`) returns nothing. Every failure is a tagged class.
9. No `runEffectAsPromise`, bare `await` on Effect values, or `fromPromise`
   around already-Effect values outside the files listed in section 4.

## 2. Non-goals and invariants (violating these fails the task)

1. **Wire-identical behavior.** No change to messages, codes, error names,
   `_tag` values, JSON key order, status codes, or CLI output text. Tests
   assert these; if a test needs its expectation changed for any reason other
   than `_tag` additions, stop and report — you have changed behavior.
2. **E stays `Error`.** Do NOT narrow static error channels to unions. All
   ports declare `ApplicationEffect<A>` (E defaults to `Error`). Precision
   lives in failure VALUES (`_tag`/`code`), which already flow. Full static
   narrowing requires redesigning every port signature plus every fake and is
   explicitly a separate project.
3. **`mapError` untouched.** Unknown and codeless failures must keep rendering
   as the generic unavailable response, exactly as today.
4. **`ApplicationFailure` stays codeless.** It has `reason` + `message` only.
   Adding a `code` changes wire output (see `errorStatus` default arm).
   New reasons go in the `ApplicationFailureReason` union in
   `packages/application/src/ports/application.ts`.
5. **No compatibility shims.** Delete old shapes in the same change (alpha
   policy). No aliases, no overloads keeping the old wiring alive.
6. **Do not commit or push.** Report per phase. No PRs.
7. **All prose, identifiers, messages, comments in English** (repo language
   policy). No Japanese anywhere in the repo.

## 3. Target design (normative patterns — copy these shapes exactly)

### 3a. Port interface becomes a Service Tag

File: the same `packages/application/src/ports/*.ts` area, following
`usecases/terminals/terminal-services.ts` (read it first; it is the template).

Before:

```ts
export interface MuximodHostPort {
  listPanesSnapshot(): ApplicationEffect<TerminalHostSnapshot>;
}
```

After (new file per area, e.g. `usecases/daemon/daemon-services.ts`,
`usecases/agent-sessions/agent-session-services.ts`,
`usecases/auth/auth-services.ts`, `usecases/shell/shell-services.ts`,
`usecases/pairing/pairing-services.ts`, `usecases/agents/agent-services.ts`;
existing `terminal-services.ts`, `workspace-services.ts`,
`effect-runtime.ts` stay and absorb their area's remaining ports):

```ts
import { Context, Layer } from "effect";
import type { MuximodHostPort } from "../../ports/host.js";

/** Application-owned terminal host capability. */
export class MuximodHostService extends Context.Service<MuximodHostService, MuximodHostPort>()(
  "@muximo/application/MuximodHost",
) {}

/** Provides the terminal host implementation from the composition root. */
export const muximodHostLayer = (host: MuximodHostPort): Layer.Layer<MuximodHostService> =>
  Layer.succeed(MuximodHostService, host);
```

Rules:

- Tag class name: existing port name with `Port` replaced by `Service`
  (`MuximodHostPort` -> `MuximodHostService`). If a `*Service` name already
  exists for that port, reuse it; do not create duplicates.
- Identifier string: `"@muximo/application/<ShortName>"` where ShortName is
  the Tag class name minus `Service` (exactly like the template).
- One provider function per Tag: `camelCase(port) + "Layer"`, taking the
  plain port implementation, returning `Layer.succeed`.
- One area assembler per services module: `<area>Layer(dependencies: {...})`
  merging all area providers, plus an `<Area>Services` union type of the Tags.
- Every capability interface in `ports/*.ts` becomes a Tag, INCLUDING clocks,
  schedulers, loggers, and confirm callbacks (`DaemonClock`,
  `DaemonScheduler`, `SessionClock`, `SessionLogger`, confirmation ports).
  Pure data types (inputs, results, options) stay plain.
- After all consumers migrate, DELETE the old `*Port` interfaces in the same
  change. The port files keep only data types.

### 3b. Usecases consume Tags

Stateless usecases (plain functions or `Effect.fn`): replace dependency
parameters/fields with `yield* Tag` inside the program. Tests provide layers
(see 3d).

Stateful usecase classes (they hold in-memory maps: `RunAgentSession`
`completions`/`recovering`, `ResumeAgentSession` completions,
`AgentBackendAdapter.prepared`, registries): keep the class, DELETE injected
capability constructor params, `yield*` Tags inside methods. If the class
itself must be provided (shared instance), add
`static readonly layer`/`Layer.effect(() => new X())` on it; otherwise roots
construct it with `new X()` and only provide its dependency Tags. Do NOT put
shared mutable state at module scope (tests must stay isolated).

`Effect.fn("Name")` entry style stays. Keep existing span names.

### 3c. Adapters become Layers, roots assemble

Infrastructure adapter classes keep their shape but their public methods must
already return Effects (they do, except the Promise-native provider layer —
see section 4). Roots (`packages/muximod/src/server.ts`,
`apps/muximo-cli/src/cli/compose.ts` and its adapter factories) build
`<area>Layer({...})`, merge with `Layer.mergeAll`, and provide once per
execution boundary. The single `runPromise` per boundary stays where it is.

`muximod-service.ts` and `auth-service.ts` Promise facades STAY (transport-
facing API stability). Do not delete or Effect-ify them.

### 3d. Tests provide Layers

Copy `workspaces.test.ts` (`Effect.provide(fixture.layer)`) and
`reconcile-panes.test.ts` (`Layer.mergeAll` + `applicationClockLayer`).
Fixture = plain fake implementations (unchanged shape) + one layer assembly.
`execute` returns the Effect; the table runner executes it
(`resolveMaybePromise` handles Effects). Assertion style unchanged
(`hasError` accepts extra fields like `_tag` via its index signature — use
that to lock tags on converted expectations).

Table-driven test rules (mandatory, from repo skill): typed declarative rows,
complete fixture selection, shared execution, post-execution observation,
named assertions, aggregate failure reporting. New test files must satisfy
`bun run test:table`.

## 4. What stays Promise (do not "fix" these)

1. `AgentPluginV1` and monitor/sidecar callback shapes (`prepareLaunch`,
   `launch`, `detect`, `AgentMonitor.start(sink)`, `abortSession`,
   `dispose`): extension/plugin API. Promise is friendlier and correct there.
2. `AgentBackendLaunch.abortSession/dispose` fields: provided by plugins.
3. Background handle factories with explicit lifecycles:
   `watchCodexSessionName` (start/stop handle), the remote-operation mutex in
   codex `manageRemoteOperation` (promise-chain serialization — do NOT rewrite
   into a semaphore), launch foreground signal-handler cluster (bridge only at
   its two existing `runEffectAsPromise` points).
4. Transaction runner (`persistence/transaction.ts`): executing Effects inside
   a DB transaction plus retry/sleep is its job; bridges stay.
5. Transport callbacks demanding `Promise`: observation `resolveWorkspace`,
   oRPC/HTTP handlers, CLI commander actions, `MuximodSocket` event wiring.
6. `runPromise` only at composition roots and in `test-support`'s resolver.
   After migration, `grep -rn "runEffectAsPromise\|Effect.runPromise"` outside
   tests must show ONLY: `infrastructure/src/effect.ts` (definition),
   `muximod-service.ts` + `auth-service.ts` facades, `server.ts` boundaries,
   `launch.ts` foreground cluster, `transaction.ts`, `test-support/table.ts`.
   Anything else is a regression — fix it.
7. `fromPromise` only around a single foreign call (fetch, spawn, fs, socket,
   timer, plugin call). Never around already-Effect values, never around
   multi-step orchestration (that orchestration is a gen body).
8. CLI Zod argv schemas stay Zod. Never embed Effect schemas in them (one past
   incident each in `run.ts` and `tmux.ts`).
9. `AsyncLocalStorage` transaction context stays (separate project).
10. `Id.create` defense-in-depth sites already covered by wire validation stay
    unwrapped; `resetTo`/`transitionTo` internal guards stay throwing.

## 5. Phases (strictly in order; gate each phase before the next)

- Phase 1: Add all Service Tags + provider functions + area assemblers
  alongside the existing interfaces. No consumer changes. Gate: typecheck.
- Phase 2: Migrate usecase bodies to `yield* Tag`. Keep classes/fakes shapes
  otherwise. Gate: typecheck + `test:local` (only the known environmental
  web-daemon failure allowed, section 6).
- Phase 3: Convert adapter internals still mixing Effect-port calls into
  async (`cli/backend.ts` leftovers if any remain, `selection.ts`-style
  readers). Leaf `fromPromise` only. Gate: typecheck + tests.
- Phase 4: Roots assemble Layers; delete old port interfaces + manual wiring
  helpers in the same change. Gate: typecheck + tests + `check:architecture`.
- Phase 5: Migrate all test fixtures to provide Layers; add `_tag`
  assertions to converted expectations. Gate: `test:table` + full suite.
- Phase 6: Full verify (section 1, items 1-8) + update the handover doc
  (`docs/temporary-effect-v4-migration-handover.md`) with the session record.

## 6. Verification commands (run from the worktree root)

```sh
node node_modules/turbo/bin/turbo run typecheck   # expect 16 successful
bun run check:architecture                        # expect valid
bun run test:table                                # expect pass, all files
bun run test:local                                # expect 934+ pass; ONLY
                                                  # "Web daemon lifecycle" may fail (sandbox EPERM)
node ./node_modules/vitest/vitest.mjs run src --pool=threads  # apps/web, expect 219/219
node node_modules/turbo/bin/turbo run build       # expect 9/9
bun run audit:public                              # expect clean
bunx biome ci .                                   # expect clean except docs/logo-exploration.html
```

## 7. Beta API facts (effect@4.0.0-beta.107 — do NOT trust v3 docs or memory)

- EXISTS: `Effect.catch`, `Effect.ignore`, `Effect.orElseSucceed`,
  `Effect.option`, `Effect.result` (`. _tag === "Failure"`, `.failure` /
  `.success`), `Effect.suspend`, `Effect.fn.Return<A, E>`,
  `Effect.acquireUseRelease`, `Effect.ensuring` (finalizer must be
  infallible — wrap fallible cleanup in `Effect.ignore`),
  `Schema.TaggedError`, `SchemaParser.decodeUnknownResult` (sync, returns
  `Result` with `.success`/`.failure` failing as `SchemaIssue.Issue`),
  `Schema.declareConstructor`, `Fiber.join` (exists; plain `Effect.fork`
  does NOT — use `forkScoped`/`forkDetach`/`forkIn`/`forkChild` if you must).
- DOES NOT EXIST: `Effect.catchAll`, `Effect.try`, `Effect.void`,
  `Effect.fork`, `Schema.toStandardSchemaV1` under a different name (it IS
  `Schema.toStandardSchemaV1`; importing `Schema` from `"effect"` resolves the
  workspace beta, not a stale 3.x copy — run probes from inside the worktree).
- `Effect.race` resolves simultaneous completions left-first. Daemon
  `waitForHealthyOrExit` DEPENDS on this (exit observation is raced on the
  left). Do not reorder. Verified by timing-sensitive tests
  (`sleeps: []` vs `[50, 50]`).
- `Effect.fn("Name")({ self: this }, function* (this: X, ...) {...})` is the
  method style; never `.pipe` after `Effect.fn`.
- `Result` accessors are `.success`/`.failure` (not `.value`).
- `Schema.decodeUnknownSync` THROWS; `decodeUnknownResult` returns `Result`.
  `onExcessProperty: "error"` must be passed at every boundary decode.

## 8. TypeScript / Biome pitfalls learned in this repo

- `Awaited<>` does not unwrap Effects. Use `Effect.Effect.Success<>` or the
  underlying option type directly.
- Spreading a class instance drops methods: plain-object expectations need
  `as ClassName` casts; entity methods must operate on `Encoded` snapshots.
- Effect `Struct` field declaration order IS the encode key order (tests
  compare exact JSON). Tag literals go first.
- `discriminatedUnion`/`unionCase` in contract are load-bearing custom
  dispatch (same-tag members tried in order, first failure surfaces). Do NOT
  replace with plain `Schema.Union` (degrades issue paths).
- Computed keys (`{ [tag]: ... }`) widen to index signatures; the codebase
  works around this with `Record<Tag, typeof tagSchema>` casts. Keep them.
- `StandardSchemaV1` needs the direct `@standard-schema/spec` dependency for
  portable declaration emit.
- `in`-narrowing works on unions; property access does NOT narrow inside
  closures — copy to a `const` first.
- Biome: import order is enforced (`check --write` fixes); `useExportType`
  (`export type { X }`); `noUselessThisAlias` fires on `const self = this`
  ONLY when truly unnecessary — inside plain `function*` passed to
  `Effect.gen`, the alias is REQUIRED and the rule stays silent.
- `bunx tsc -p <pkg>/tsconfig.json` is quick per-package checking; `turbo
  run typecheck` also runs builds (`build` uses `tsconfig.build.json`,
  which includes test files and declaration emit — stricter).
- Never use `cd`; pass `workdir` to the shell tool. Never `rm` files;
  tracked deletions go through `git rm`. Never `git clean`, `reset --hard`,
  or broad checkouts. Never create files outside the repo except the
  system temp dir.

## 9. Sandbox and repo operating rules

- `bun`/`node` execution works from inside the worktree; `git` works.
  `gh` CLI is unusable here (config unreadable) and there are no GitHub
  credentials: do NOT push, do NOT create PRs, do NOT amend pushed commits.
  Do NOT commit at all unless explicitly asked.
- New files are untracked until staged; do not leave scratch files behind
  (temp probes go in the system temp dir and get deleted the same command).
- `kill` syscalls are blocked: anything spawning real processes
  (web-daemon test, vitest forks pool) fails environmentally. This is
  pre-existing and unrelated to the migration.
- Write English only, everywhere (code, comments, messages, docs, tests).
- Table-driven tests live alongside code (`*.test.ts`), never invent new
  test frameworks. `hasError` extra fields (e.g. `_tag`) flow into
  `toMatchObject` — use them.
- On any red gate: fix forward within the phase. On ambiguity about intended
  behavior: consult base commit `07300ff` (`git show 07300ff:<path>`), keep
  base semantics, and record the decision in the handover doc. Never guess
  wire behavior.
