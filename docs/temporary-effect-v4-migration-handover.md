# Temporary Effect v4 Migration Handover

Status: working handover document. Remove this file or fold its durable decisions into the permanent architecture documents after the migration stabilizes.

Date: 2026-09-03

Worktree: `.worktrees/effect-evaluation`

Branch: `codex/effect-evaluation`

Base commit: `07300ff76d20d3e36e602616644bed0d42d8d5b8`

## Purpose

This document hands the Effect v4 migration to the next agent. It records the current implementation, the intended end state, the dependency-injection and testing strategy, and the order in which the remaining work should be performed.

The repository is an alpha application. The migration may change internal and public shapes when that makes the current design clearer. Do not add compatibility aliases, fallback paths, or legacy adapters solely to preserve the pre-migration implementation.

This document is not a substitute for the source code, contracts, tests, `AGENTS.md`, or the Clean Architecture skill. It is a map of the current work and the decisions that the next agent must preserve.

## Executive decision

Adopt Effect decisively at the application boundary and continue toward an Effect-native runtime. The useful boundary is not “add a few `Effect` wrappers around Promise usecases”; it is:

- domain code remains pure and can use Zod-backed, class-based domain objects;
- domain models with Effect Schema (`Schema.Class` entities, branded ids,
  shared bare field schemas) while keeping the Effect runtime
  (`Effect.gen`/`Effect.fn`/services/layers) out of `packages/domain`;
  `Schema` is a pure validation library, not runtime orchestration;
- application usecases are named `Effect.fn` programs;
- application-owned external capabilities become Effect services and layers over time;
- infrastructure constructs concrete implementations only;
- composition roots provide layers and interpret effects at explicit process, HTTP, CLI, or WebSocket boundaries;
- resource acquisition, use, release, cancellation, and cleanup are represented by Effect resource combinators;
- internal failure vocabularies are owned by the usecase or port that can produce them;
- public client-facing errors remain centrally mapped to the wire contract at the transport boundary.

The current branch is an intentional Phase A hybrid. Usecase entrypoints have been converted to named Effects, but many ports and transport-facing facades still return Promises. The next agent must not mistake this for the final architecture or widen the hybrid accidentally.

## Current state at handoff

The worktree contains pre-existing uncommitted implementation changes. Preserve them. Start with:

```sh
git status --short
git diff --stat
```

Do not run `git reset --hard`, `git checkout --`, or any broad cleanup command. The expected branch is `codex/effect-evaluation` in the worktree listed above.

### Dependencies and shared helpers

`effect@4.0.0-beta.107` is currently declared by the application, muximod, CLI, and test-support packages. The lockfile has been updated.

The application package owns the small transition helpers in:

- `packages/application/src/effect.ts`
- `packages/application/src/effect-runtime.ts`

`effect.ts` currently provides:

- `ApplicationEffect<A, E, R>` as the application-level alias;
- `fromPromise` for adapting an existing asynchronous capability;
- `normalizeError` for preserving `Error` instances and structured error properties when a Promise rejects with a non-`Error` value.

`effect-runtime.ts` currently provides `ApplicationClockService` and `applicationClockLayer`. This is the first application-owned runtime service. It is not evidence that every port has already become a Context service.

The transition helper is deliberately small. It is an integration boundary, not a reason to hide Promise behavior throughout the application layer. Rejected values must remain observable; `fromPromise` must not swallow failures.

### Converted application usecases

Real application usecase entrypoints are now named `Effect.fn` programs in these areas:

- panes: list, list-current, send-input, resize, and create;
- terminals: pane reconciliation;
- sessions: list, create, and manage;
- workspaces: find, list, register, update, delete, and record factory operations;
- agent lifecycle: run, resume, cleanup, list, locate, and attach;
- agent pane control: adopt, observe, and release;
- authentication: pairing, claim, challenge, session creation, active-device checks, session context, WebSocket ticket consumption, and ticket issuance;
- daemon: ensure, stop, status, start, and restart;
- pairing: pair device;
- shell: run shell.

Some lifecycle usecases still contain Promise-based internal sections. This is intentional for the current migration step because prepare, attach, complete, recovery, and idempotency behavior must not be changed while changing the effect boundary. Those sections are adapted with `fromPromise` until their ports are migrated.

### Explicit Promise boundaries that remain

The following boundaries still interpret Effects into Promises:

- `packages/application/src/usecases/muximod/muximod-service.ts` keeps a transport-neutral Promise facade for the current muximod application port;
- `packages/application/src/usecases/auth/auth-service.ts` keeps the current transport-facing Promise facade while its core authentication flows are Effect programs;
- `packages/muximod/src/launch.ts` interprets daemon Effects at the composition root;
- `packages/muximod/src/server.ts` interprets agent lifecycle Effects at the runtime/composition boundary;
- `apps/muximo-cli/src/cli/compose.ts` and CLI command adapters bridge Effects to the existing command contract.

`Effect.runPromise` is acceptable at these explicit boundaries. It should not be introduced inside domain logic or as an implementation shortcut inside a usecase that can remain an Effect.

### Worktree and cleanup changes already made

The shell worktree capability now returns a complete allocation:

```ts
type ShellWorktreeAllocation = {
  worktreeRoot: string | null;
  worktreePath: string;
  branch: string | null;
  baseCommit: string | null;
};
```

The shell usecase now uses the following resource policy:

- pane metadata is restored with `Effect.ensuring`;
- managed worktree allocation, use, and release are grouped with `Effect.acquireUseRelease`;
- cleanup hooks are attempted even when shell execution fails;
- worktree removal is attempted after the cleanup hook, including when the hook reports failure;
- removal failure wins over earlier cleanup failure because retained or unknown worktrees must not be reported as successful cleanup;
- a retained worktree is surfaced as an error rather than silently treated as success;
- a created host session is killed when later setup or use fails, while preserving the original failure where possible.

The infrastructure adapter returns `false` when its safety policy retains a dirty, unregistered, or otherwise uncertain worktree. It returns `true` only after removal succeeds. This distinction must remain visible to the application policy.

The current shell tests cover success, non-zero shell exit, copy failure, setup failure, cleanup-hook failure, retention, and shell selection.

### Test-support transition

`packages/test-support` can resolve both existing Promise results and Effect results during the migration. Treat that resolver as a temporary test harness bridge. Once all relevant ports and test fixtures are Effect-native, remove the old shape in the same change rather than preserving it as a compatibility API.

### Incidental fix included in the branch

CLI parser-only help detection now examines parser arguments before the `--` separator. For example, `serve tailscale --help` does not initialize the database or composition root. Keep the regression test when changing CLI composition.

## Target dependency direction

The dependency direction remains the Clean Architecture direction:

```text
packages/domain
       ^
packages/application  (usecases, ports, Effect services)
       ^
interface adapters and infrastructure adapters
       ^
composition roots      (muximod runtime, CLI, server/entrypoints)
       ^
delivery boundaries    (HTTP, WebSocket, CLI process)
```

The diagram describes dependency direction, not call direction. Runtime calls flow from a delivery boundary into a composition root, through an application usecase, into an application-owned port, and then into an infrastructure implementation.

`packages/contract` owns wire schemas and codecs. It may derive or reference domain shapes only according to the existing repository dependency rules; it must not import application implementations, infrastructure adapters, or Effect runtime services merely to validate a wire payload.

The important rule is ownership:

- domain owns business invariants and pure policies;
- application owns orchestration, usecase failure vocabulary, and capability interfaces;
- infrastructure owns concrete I/O and host integrations;
- contract owns wire representation;
- composition roots own concrete layer assembly and effect interpretation;
- clients own presentation of the public wire error contract.

## Layer-by-layer design

### Domain

Keep the domain pure. Zod and class-based domain objects are compatible with the Effect migration and can provide useful DDD behavior:

- branded identifiers and value objects;
- constructor/factory validation;
- `encode` and `decode` at explicit serialization boundaries;
- invariant-preserving member methods;
- pure policies and state transitions;
- domain-specific errors that do not know about HTTP, SQLite, Bun, or Effect runtime services.

A domain class may be stateful with respect to its own value, but it must not acquire repositories, clocks, loggers, filesystem handles, or cancellation scopes from a global runtime. Pass required values explicitly or keep the operation in the application layer.

Illustrative shape:

```ts
import { z } from "zod";

const WorkspaceNameSchema = z.string().trim().min(1).max(100);

export class WorkspaceName {
  private constructor(readonly value: string) {}

  static decode(input: unknown): WorkspaceName {
    return new WorkspaceName(WorkspaceNameSchema.parse(input));
  }

  encode(): string {
    return this.value;
  }

  equals(other: WorkspaceName): boolean {
    return this.value === other.value;
  }
}
```

Do not make every domain function return `Effect` just because the application uses Effect. A pure validation or state transition should remain a direct function or class method. Use Effect when the operation needs failure channels, cancellation, asynchronous capabilities, resource scopes, or runtime services.

### Application ports

Application ports describe capabilities required by usecases. The target shape is an Effect return type with a failure type that is meaningful at the port boundary:

```ts
import type { Effect } from "effect";

export type RepositoryFailure =
  | { readonly _tag: "RepositoryUnavailable"; readonly cause: unknown }
  | { readonly _tag: "RepositoryConflict"; readonly key: string };

export interface WorkspaceRepository {
  findById(id: WorkspaceId): Effect.Effect<Workspace | null, RepositoryFailure>;
  save(workspace: Workspace): Effect.Effect<void, RepositoryFailure>;
}
```

The exact failure representation is still an open migration decision. Current code primarily uses `Error` subclasses and code-bearing errors. Do not claim exhaustive tagged errors until the port has actually adopted them and all callers handle them.

Ports should be owned by `packages/application`. Infrastructure must implement them; application must not import an infrastructure class to obtain one.

### Application services and layers

Use Context services for shared runtime capabilities whose implementations belong to the composition root. Define the service interface in application and provide the concrete implementation from muximod, CLI, or another root:

```ts
import { Context, Effect, Layer } from "effect";

export class WorkspaceRepositoryService extends Context.Service<
  WorkspaceRepositoryService,
  WorkspaceRepository
>()("@muximo/application/WorkspaceRepository") {}

export const workspaceRepositoryLayer = (
  repository: WorkspaceRepository,
): Layer.Layer<WorkspaceRepositoryService> =>
  Layer.succeed(WorkspaceRepositoryService, repository);
```

Use `Layer.effect` when construction itself is effectful, and compose independent services in the composition root:

```ts
const applicationLayer = Layer.mergeAll(
  workspaceRepositoryLayer(workspaceRepository),
  applicationClockLayer(clock),
  loggerLayer(logger),
);
```

Do not create a single giant service containing every repository and host operation. Keep service interfaces cohesive and aligned with bounded capabilities. Pure policies and object-specific domain state should continue to use ordinary constructors and function arguments.

### Usecases

Each usecase should be a named `Effect.fn` program. Dependencies come from Context services in the target design, while pure input validation and domain construction stay direct:

```ts
import { Effect } from "effect";

export const createWorkspace = Effect.fn("Workspaces.create")(
  function* (input: CreateWorkspaceInput) {
    const repository = yield* WorkspaceRepositoryService;
    const clock = yield* ApplicationClockService;
    const name = WorkspaceName.decode(input.name);
    const workspace = Workspace.create({ name, now: clock.now() });

    yield* repository.save(workspace);
    return workspace;
  },
);
```

Usecase naming and files should remain focused. A usecase may call domain methods and multiple ports, but it should own the orchestration policy. Keep public behavior and idempotency semantics stable while changing the representation.

Do not call `Effect.runPromise` in the usecase body. Do not make a usecase accept an already-running `Effect` from a caller unless that is explicitly part of the port contract; prefer input values and application services.

### Infrastructure

Infrastructure adapters implement application ports and translate host failures into the application-facing failure vocabulary. They may use Bun, SQLite, filesystem, Git, tmux, process APIs, or other runtime facilities, but those dependencies must not leak into domain code.

When an adapter has a safety-sensitive result, model the result explicitly. For example, shell worktree removal distinguishes `true` (removed) from `false` (retained by policy). Do not turn an uncertain cleanup result into a successful unit of work.

Infrastructure constructors should be ordinary functions or Effect layers depending on whether construction needs resources. Resource-owning infrastructure must expose a release path and must be provided inside an appropriate scope.

### Composition roots

`packages/muximod` and CLI composition are responsible for:

- constructing infrastructure adapters;
- assembling application service layers;
- selecting the root scope and runtime strategy;
- interpreting effects at process and transport boundaries;
- configuring logging, configuration, authentication, and host integrations.

The first migration can continue to use `Effect.runPromise` at these roots. Later, use `ManagedRuntime` or a long-lived runtime where repeated requests should reuse an assembled layer and its resources. The decision must be made per process boundary and tested for shutdown behavior.

An entrypoint should make the boundary visible:

```ts
const program = createWorkspace(input).pipe(
  Effect.provide(applicationLayer),
);

const result = await Effect.runPromise(program);
```

For a server, keep the runtime/layer alive for the server lifetime and close it during shutdown. Do not create a new database or host process resource for every request unless the adapter contract explicitly requires it.

### Delivery and client layers

HTTP, WebSocket, and CLI adapters translate between external input/output and application programs. They should:

- decode request input with the contract schema;
- call an application usecase;
- map the usecase result or failure to the public protocol;
- never expose an internal adapter error shape by accident;
- keep the public error mapping centralized.

The current centralized server mapping is in `packages/muximod/src/http/middleware.ts`. The browser API client centrally normalizes oRPC failures into `MuximodApiError`, and viewmodels use the shared error formatter. Preserve this central public mapping while internal failures become more distributed.

## Dependency injection and test design

The DI change should make tests more deterministic, not force every test to boot a full application runtime.

### Domain unit tests

Instantiate classes and call pure policies directly. Do not build an Effect layer for a test that only checks a value object invariant or a state transition.

```ts
const name = WorkspaceName.decode("alpha");

expect(name.encode()).toBe("alpha");
```

### Application unit tests

Create a fresh fake capability set for each table row. Provide that set through a small test layer. Run the usecase once, then inspect recorded calls and state:

```ts
const makeTestLayer = (fixture: Fixture) =>
  Layer.mergeAll(
    workspaceRepositoryLayer(fixture.workspaceRepository),
    applicationClockLayer(fixture.clock),
  );

const runCase = (fixture: Fixture, input: CreateWorkspaceInput) =>
  Effect.runPromise(
    Effect.result(
      createWorkspace(input).pipe(Effect.provide(makeTestLayer(fixture))),
    ),
  );
```

Tests should assert both the returned outcome and post-execution observations such as repository writes, emitted events, process calls, pane metadata, or cleanup order. The existing table-driven test skill remains mandatory: use typed declarative rows, complete fixture selection, one shared execution path, named assertions, and aggregate failure reporting.

For failure assertions, inspect the failure value explicitly. If the migration has not yet introduced tagged errors for a bounded context, assert the current stable `Error`/`code` contract rather than pretending the error union is exhaustive.

### Integration tests

Use real SQLite and infrastructure adapters only where adapter behavior or composition matters. Provide them through a test layer or a test composition root. Keep external process, filesystem, and network behavior explicit and deterministic.

Integration tests should verify:

- concrete adapters satisfy application ports;
- layers assemble without hidden global state;
- transaction and resource scopes close correctly;
- public error mapping does not leak internal failures.

### Resource and cleanup tests

Resource tests should record ordered events and exercise every failure branch:

```text
acquire -> use succeeds -> release
acquire -> use fails -> release
acquire -> release fails
acquire -> cleanup hook reports false -> remove is still attempted
acquire -> safety policy retains resource -> retained result is surfaced
```

Use `Effect.result` around the program when the test needs to observe a failure without throwing. Use `Effect.scoped` when the fixture contains scoped services. Assert that finalizers run on success, failure, and interruption where the behavior matters.

For the current custom `ApplicationClock`, provide a deterministic fake that returns the expected ISO string. If the code later adopts Effect's `TestClock`, make the clock contract consistent first; do not mix two clock representations in one usecase.

### Test table shape

A representative row should select all fixtures required by the scenario:

```ts
type Case = {
  readonly name: string;
  readonly input: CreateWorkspaceInput;
  readonly fixture: Fixture;
  readonly expected: {
    readonly outcome: "success" | "failure";
    readonly errorCode?: string;
    readonly savedNames: readonly string[];
  };
};
```

Keep execution shared across rows. Capture the result and observations before assertions. Avoid a separate hand-written test path for each failure branch.

## Error strategy

The apparent tension between distributed error definitions and centralized frontend handling is resolved by separating two vocabularies:

1. Internal failures are distributed to the code that can produce and recover from them. A repository can own storage failures; a usecase can own domain/application policy failures; an adapter can translate host errors at its boundary.
2. Public failures are centralized at the delivery boundary. `mapError` converts internal failures into the public wire error contract, and clients consume that stable contract through `MuximodApiError`.

This gives local ownership without exposing infrastructure details to the frontend. A frontend should never need to know whether a failure came from SQLite, Git, tmux, or a repository implementation.

### Future error phase

The current branch uses `Error` instances and code-bearing errors in many places. A later bounded-context migration may introduce explicit tagged errors, for example with an Effect Schema `Schema.TaggedErrorClass` or a repository-local discriminated union. If that is done:

- define the error vocabulary close to the usecase/port that owns it;
- preserve causes for logging and recovery;
- make mapping in `packages/muximod/src/http/middleware.ts` exhaustive for the public contract;
- keep internal error tags out of wire payloads unless the contract intentionally names them;
- update all callers and tests in the same change.

Do not add a central “all possible errors” registry merely to make the frontend mapping easy. The central registry should be the public contract mapping, not ownership of every internal failure.

## Cleanup and resource rules

The main reason to adopt Effect beyond syntax is reliable resource behavior. Apply these rules consistently:

- acquire, use, and release a resource in one `Effect.acquireUseRelease` when the lifetime is local to one operation;
- use `Effect.ensuring` for state restoration that must happen regardless of success or failure;
- use `Scope`/`Effect.scoped` for resources whose lifetime spans multiple composed effects;
- make finalizers idempotent and safe when the resource was only partially created;
- make cleanup failures observable and actionable;
- define precedence when both the primary operation and cleanup fail;
- treat an uncertain or retained security-sensitive resource as a failure, not as successful cleanup;
- preserve the original operation failure when a best-effort secondary cleanup fails, unless the safety policy explicitly gives cleanup precedence;
- never detach a cleanup finalizer from the Effect that owns the resource;
- test success, failure, interruption, and partial acquisition.

The existing shell worktree implementation intentionally gives removal failure precedence because leaving an unknown worktree behind is a safety failure. Apply the same reasoning to sessions, processes, temporary files, and authentication tickets, but decide precedence per resource policy rather than copying it blindly.

`finally` may remain temporarily around code that has not crossed the Effect boundary. It is not the target for new resource-owning code. Migrate those sections only with behavior-preserving tests.

## Migration plan

### Phase A: current branch — usecase Effect boundary

Completed in this worktree:

- add the Effect dependency and lockfile entries;
- add application Effect helpers and the initial clock service;
- convert application usecase entrypoints to named `Effect.fn` programs;
- keep explicit Promise facades at current transport/composition boundaries;
- harden shell worktree/session cleanup;
- add and update table-driven tests;
- preserve centralized public error mapping;
- fix parser-only CLI help initialization regression.

### Phase B: application-owned service inventory

Next, inventory every asynchronous application port and classify it:

- repository/database capability;
- host/session/process capability;
- clock and scheduler;
- authentication/session store;
- logger/telemetry;
- filesystem/Git/tmux/shell capability;
- external API or network capability.

For each capability, define the minimal application interface and its failure contract under `packages/application`. Convert the port method to `Effect` without importing infrastructure. Add a production implementation layer in the appropriate composition root and a fake layer in application tests.

Do this one bounded context at a time. Do not create a giant “application runtime” service as a shortcut.

#### Inventory recorded 2026-09-03 (Phase C.1 session)

Capability inventory by port file under `packages/application/src/ports/`:

- workspaces (`repositories.ts` `WorkspaceRepository`, `workspace.ts` `WorkspaceDirectoryPort`/`WorkspaceAuditPort`, `transactions.ts` `TransactionManager`, `host.ts` `MuximodWorkspaceCatalogPort`): **migrated in Phase C.1** (see below). `browseDirectories` stays Promise until the sessions/panes slice; `toDirectoryOption` stays synchronous (pure).
- sessions, panes, terminals (`repositories.ts` `PaneRepository`, `host.ts` `MuximodHostPort`/`MuximodSessionManagementPort`/`MuximodViewportPort`/`MuximodTerminalObservationPort`, `panes.ts` `PaneGateway`, application-owned session/agent-status state): next slice (Phase C.2).
- agent lifecycle and pane control (`agent-sessions.ts`: session/launcher/remote/resource/observation/naming/hook/worktree/audit/logger/confirm/process ports): Phase C.3. Includes removing the `runEffectAsPromise` bridge in `WorkspaceResolverAdapter` (`packages/infrastructure/src/cli/workspace.ts`) by converting `WorkspaceResolverPort` with its callers.
- authentication and pairing (`auth.ts`, `auth-types.ts`, `pairing.ts`, `pairing-types.ts`): Phase C.4.
- daemon and CLI orchestration (`daemon.ts` runtime/clock/scheduler ports): Phase C.5.
- shell, worktrees, host process resources (`shell.ts`, `agent-sessions.ts` `WorktreePort`): Phase C.6.
- cross-cutting: `ApplicationClock`/`ApplicationClockService` already a Context service; `TransactionManagerService` introduced in Phase C.1 and reused by later slices.

### Phase C.1: workspaces and repositories — completed 2026-09-03

Application ports converted to `Effect` (failure channel `Error`, matching the current `Error`/code-bearing contract; no new tagged errors claimed):

- `WorkspaceRepository` (`ports/repositories.ts`): all five methods return `ApplicationEffect`.
- `WorkspaceDirectoryPort` / `WorkspaceAuditPort` (`ports/workspace.ts`): all methods return `ApplicationEffect`.
- `TransactionManager` (`ports/transactions.ts`): `run<A>(operation: ApplicationEffect<A>): ApplicationEffect<A>`. The operation must require no services: resolve Context services before calling `run` and close over the resolved values, so the scope stays executable (including SQLite busy retries) without ambient service propagation. The database-only contract is unchanged.
- `MuximodWorkspaceCatalogPort` (`ports/host.ts`): `resolveWorkspaceDirectory`/`resolveSelection` take `(id) => ApplicationEffect<...>` readers and return `ApplicationEffect`. `browseDirectories` stays Promise until Phase C.2; `toDirectoryOption` stays synchronous.

New application-owned services and layers (`usecases/workspaces/workspace-services.ts`):

- `WorkspaceRepositoryService`, `WorkspaceDirectoryService`, `WorkspaceAuditService`, `TransactionManagerService` with `...Layer` constructors, plus a `workspaceLayer({ repository, directories, audit?, transactions? })` composer and explicit `noopWorkspaceAuditLayer` / `passthroughTransactionManagerLayer` for the previously optional audit/transaction dependencies.

Usecases rewritten as service-consuming `Effect.fn` programs (classes removed, no aliases kept):

- `listWorkspaces`, `registerWorkspace`, `updateWorkspace`, `deleteWorkspace`, `createWorkspaceRecord`, `updateWorkspaceRecord`, `findWorkspace(selector)`. Transactional writes resolve services first, then run an R-free program inside `transactions.run`, preserving the previous insert/upsert/delete-plus-audit atomicity and ordering (factory/find work stays outside the scope, as before). The `runInTransaction` Promise helper was removed.

Composition roots and facades:

- `MuximodApplicationResources` drops the four usecase class fields and carries `workspaceLayer: Layer.Layer<WorkspaceServices>`; the facade runs workspace programs through `runWorkspaceEffect` (provides the workspace layer merged with the application clock layer). `workspaceRepository` stays as a resource for the not-yet-migrated sessions/panes call sites.
- `packages/muximod/src/server.ts` builds `workspaceLayer` from the Drizzle repository, selection catalog, audit sink, and optional transaction manager; the audit sink and all infrastructure workspace implementations are `Effect`-returning (built with `fromPromise`, no new `effect` package dependency in infrastructure).
- `create-session` / `create-pane` pass Effect-returning finders into the catalog; otherwise unchanged (their own service migration is Phase C.2).

Temporary bridges (all marked, all greppable, all removed in the noted phase):

- `runEffectAsPromise` (`packages/application/src/effect.ts`): temporary migration bridge for infrastructure code whose callers still expose Promise methods. Used only in `packages/infrastructure/src/workspace/selection.ts` (Effect readers), `packages/infrastructure/src/cli/workspace.ts` (`WorkspaceResolverAdapter`, remove in Phase C.3 with `WorkspaceResolverPort`), and `packages/infrastructure/src/persistence/transaction.ts` (Effect scope execution inside the existing Promise-based SQLite machinery). Never use it in new application orchestration; yield the Effect directly instead.

Tests updated in the same change (table-driven shape preserved):

- `workspaces.test.ts` / `find-workspace.test.ts`: Effect fakes, per-fixture layers (`workspaceLayer` + `applicationClockLayer`), shared execute/provide/observe paths.
- Infrastructure `transaction.test.ts` (Effect scopes including the nested-scope case), `transaction-table.test.ts`, `persistence/index.test.ts` (workspace repo calls), `selection.test.ts` (Effect catalog calls and readers), `cli/workspace.test.ts` (Effect fakes; adapter Promise surface unchanged).

### Phase C: Context-based DI by bounded context

Migrate in this order unless code dependencies require a small adjustment:

1. workspaces and repositories;
2. sessions, panes, and terminals;
3. agent lifecycle and pane control;
4. authentication and pairing;
5. daemon and CLI orchestration;
6. shell, worktrees, and host process resources.

For each context:

- convert its port return types;
- add application service definitions;
- add production and test layers;
- remove constructor/service-locator workarounds only when all callers are updated;
- update unit, integration, and transport tests;
- run architecture checks and targeted tests.

Pure domain helpers remain direct functions/classes throughout this phase.

### Phase D: remove remaining Promise facades

After all callers of a bounded context are migrated, move its Promise facade to an explicit adapter or composition boundary. Update `MuximodApplication` and `MuximodAuthPort` only when all in-repository callers can change in the same commit. Alpha policy permits removing the old shape; do not leave compatibility methods or overloads.

At the end of this phase, the application package should have no `Effect.runPromise` calls except an explicitly documented boundary that is genuinely part of an application-owned delivery adapter. Prefer keeping interpretation in muximod/CLI entrypoints.

### Phase E: typed errors and public mapping

Choose a single error representation per bounded context, introduce tagged errors or explicit unions where exhaustive handling provides real value, and update central transport mapping. Verify that clients still receive only the public contract shape and that causes remain available for logs.

### Phase F: long-lived runtime and resource scopes

Review every long-lived server and CLI resource:

- decide whether a `ManagedRuntime` or an explicit scoped program is appropriate;
- close layers during shutdown;
- verify cancellation and interruption behavior;
- verify no database, process, or WebSocket resource leaks across repeated operations;
- add tests for shutdown and partial startup failure.

## Non-goals and pitfalls

- Do not add Effect runtime (`Effect.gen`/`Effect.fn`/services/layers) to
  `packages/domain` or `packages/contract` only for stylistic consistency.
  Effect Schema modeling in those packages is the adopted direction (see the
  domain Schema+class record below), because schemas are pure validation, not
  orchestration.
- Do not turn pure synchronous validation or domain transitions into Effects without a runtime need.
- Do not pass an `Effect` value across HTTP, WebSocket, or CLI wire boundaries.
- Do not call `runPromise` inside domain code or ordinary application orchestration.
- Do not use `Effect.catch` to silently convert a domain failure into success.
- Do not retry non-idempotent writes without an explicit idempotency policy.
- Do not put asynchronous callbacks inside Bun SQLite transactions when the transaction contract is synchronous.
- Do not let an adapter-specific error code become a public client contract by accident.
- Do not collapse agent prepare/attach/complete/recovery boundaries into one opaque transaction; preserve their current lifecycle and idempotency semantics.
- Do not weaken authentication, Origin, ticket, or credential ownership boundaries during DI refactoring.
- Do not let a retained shell worktree, process, or temporary resource look like a successful operation.
- Do not edit the main checkout when the task is scoped to this worktree.

## File map

Start with these files and related tests:

- [application Effect helpers](../packages/application/src/effect.ts)
- [application runtime services](../packages/application/src/effect-runtime.ts)
- [workspace services and layers](../packages/application/src/usecases/workspaces/workspace-services.ts)
- [domain entity decode errors](../packages/domain/src/entity-errors.ts)
- [contract wire schemas and oRPC helpers](../packages/contract/src/protocol.ts)
- [current muximod application facade](../packages/application/src/usecases/muximod/muximod-service.ts)
- [current authentication facade](../packages/application/src/usecases/auth/auth-service.ts)
- [shell usecase and resource policy](../packages/application/src/usecases/shell/run-shell.ts)
- [application shell port](../packages/application/src/ports/shell.ts)
- [Git/worktree infrastructure adapter](../packages/infrastructure/src/cli/worktree.ts)
- [central public error mapping](../packages/muximod/src/http/middleware.ts)
- [muximod composition/runtime entrypoints](../packages/muximod/src/server.ts)
- [CLI composition](../apps/muximo-cli/src/cli/compose.ts)
- [Effect-aware test table support](../packages/test-support/src/table.ts)
- [permanent restructuring plan](architecture-restructuring-plan.md)
- [architecture decisions](architecture-decisions.md)
- [shell stability audit](shell-stability-audit.md)

## Handoff procedure

The next agent should:

1. read `AGENTS.md`, this document, `docs/architecture-restructuring-plan.md`, and the Clean Architecture skill;
2. inspect `git status --short` and preserve the existing uncommitted changes;
3. inspect the current usecase/port boundary before choosing the next bounded context;
4. search for remaining boundaries with:

   ```sh
   rg -n "Effect\\.runPromise|runEffectAsPromise|async execute|Effect\\.fn" packages apps
   ```

5. implement one coherent migration slice with its production layer, test layer, and tests;
6. update this handover document when a decision or phase changes;
7. run the relevant checks before handing off again.

Do not start a broad mechanical rewrite without first confirming which bounded context is being migrated and which Promise boundary is being removed.

## Verification at this handoff

The current branch was verified before this document was added:

- `bun run verify` passed;
- raw `bun test` passed with 1546 tests passing, 2 skipped, and 0 failures;
- `git diff --check` passed;
- architecture checks and table-driven test checks passed;
- build completed for all 9 packages/apps.

### Domain Schema+class migration — completed 2026-09-03

Decision (reverses the earlier Zod-only domain direction on the full-adoption
axis): `packages/domain` models with Effect Schema and exposes classes, while
`packages/contract` derives wire schemas from Effect Schema field exports and
serves oRPC through Standard Schema interop. Zod is removed from domain,
contract, and muximod in the same change (CLI argv validation keeps its own
Zod and is a separate slice).

Domain shape (`packages/domain/src/`):

- `Workspace`, `Pane`, `AgentSession` are `Schema.Class` subclasses with
  private-equivalent construction discipline (factories only), public readonly
  data fields, static `create`/`restore`/`normalizeName`/`validateName`/
  `selection`, and member `update`/`transitionTo`/`resetTo`/
  `hasActiveExecution`. Static aliases that duplicated member behavior were
  removed; pure state predicates (`canTransitionPaneState`,
  `transitionPaneState`, `isAttentionState`) and name/selection validators
  stay free functions.
- IDs stay branded strings (`Schema.brand`), keeping the `XId.create` shape;
  `valueSchema` was removed and wire id fields use local plain schemas.
- Each entity module exports bare field schemas (`WorkspaceFields`,
  `PaneFields`, `AgentSessionFields`) shared by the class definition and wire
  derivations, so field rules stay single-sourced without `.shape`/`.unwrap`
  chains.
- `decodeEntity` failures surface as the new coded `InvalidEntityError`
  (`code: "invalid_entity"`, cause preserved), replacing raw `ZodError`s from
  `create`/`restore`/member-decode paths. Pre-existing coded errors (name,
  empty-update, selection, transition, immutable-key rules) are unchanged in
  order and message.
- `packages/domain/src/entity-errors.ts` is the one new shared file (used by
  all three entity modules).

Contract shape (`packages/contract/src/protocol.ts`, `contract.ts`):

- `wire()` exposes every oRPC-bound schema through
  `Schema.toStandardSchemaV1` with `onExcessProperty: "error"` baked in,
  preserving the old `.strict()` wire behavior (unknown-field rejections are
  still tested). `struct()` is the strict object shorthand.
- `discriminatedUnion(tag, cases)` + `unionCase(tag, value, fields)` implement
  tag-dispatched unions (the tag literal is injected first, so it stays single
  source). Dispatch preserves exact member failure paths, including nested
  paths and custom cross-field paths via `Schema.makeFilter` `{ path, issue }`
  entries (used for the attach sessionId/resumeToken rule and the five
  create-pane rules).
- The agent-session wire record is an explicit DTO `Struct` composed from
  `AgentSessionFields` (not a reuse of the domain class), keeping wire
  evolution versioned behind `protocolVersion` while field rules stay shared.
- `z.infer` became `typeof X["Type"]`; `safeParse`/`parse` sites became
  `~standard.validate` (tests), `decodeUnknownResult` (frames, tmux hook,
  health probes), or `decodeUnknownSync` (encode/build paths). Effect
  `Result` (not `Either`) is the v4 data-result shape.
- `contract.ts` inputs use the same helpers; the dead `_pairingIdInput` was
  removed; contract now depends on `effect` instead of `zod`.

Callers updated in the same change: application usecases and factories use
member updates/transitions, infrastructure row mappers read validated
instances directly (no re-validation of in-memory records), muximod drops its
Zod config/hook/middleware schemas (`invalid_entity` maps to HTTP 500, the
dead `ZodError`→400 branch is gone), and the web pairing/events tests use
contract types and narrowed helpers instead of `schema.parse`. CLI argv
validation still uses its own Zod.

#### Patch ownership (2026-09-03 follow-up)

`packages/domain/src/patch.ts` owns the patch vocabulary (`Patch<T>`,
`ClearPatch`, `undefined`-keeps tri-state) and the `EntityPatch<T, Immutable>`
derivation: required entity fields are set-only, optional fields are
clearable, and immutable fields are excluded at the type level. Each entity
declares its immutable set once (`paneImmutableFields`,
`agentSessionImmutableFields`, `workspaceImmutableFields`) and shares it
between the `EntityPatch` instantiation and the runtime immutable-key guard in
its `update()` member, so type and runtime cannot drift. Unknown keys are
already rejected by strict decoding; the guard covers known-but-immutable
keys (`id`/`hostPaneId`/`hostServerId`/`state` for panes, `id` for sessions,
`id`/`rootPath`/`isGit`/`createdAt` for workspaces). This tightens two
previously silent behaviors into loud failures: `AgentSession.update` no
longer reassigns `id` through a spread merge, and `Workspace.update` no
longer drops unknown fields silently. Use cases keep building patch values
(including `updatedAt` from their clocks) and adapters keep mapping wire
`undefined`-keeps/`null`-clears into the domain patch shape. Residual: session
`workspaceId`/`backend` stay patchable (no flow patches them, nothing pins
either direction); narrow further only with a dedicated test.

Narrow use cases (e.g. `updateStatus`) build their patch inline against the
domain patch type instead of accepting a wide patch: declare a small
caller-facing input with required fields
(`{ status: AgentSessionState }`), stamp `updatedAt` from the use-case clock,
and pass the object to the member `update()`. Assignability to
`EntityPatch` then guarantees only patchable fields flow in, so `Pick` is
only needed when a use case genuinely forwards a caller-supplied partial
patch for a field subset (e.g.
`Pick<AgentSessionUpdateInput, "setupHook" | "cleanupHook">`).

#### Timestamp ownership (2026-09-03 follow-up)

Entities carry only meaningful time. `Workspace` has no timestamp fields at
all; `AgentSession` keeps `lastActivityAt` (last lifecycle activity, read by
the execution-health and worktree-grace policy); `Pane` keeps `lastSeenAt`
(observation time). `createdAt`/`updatedAt` left the entity shapes:
`WorkspaceCreateInput` and patch inputs no longer take them,
`AgentSession.create` takes `lastActivityAt`, and factories lost their
timestamp clock reads (clocks stay for transitions, observations, execution
identity, and activity stamps).

Row metadata stays in the tables with no migration: repositories stamp
`createdAt` on insert and `updatedAt` on every write from an injected clock
(defaulting to wall time, faked in tests). Panes preserve both on
conflict-update so reconcile touches stop rewriting history; sessions and
workspaces bump `updatedAt` on every write because those tables have no
polling touch path. Session rows map `updatedAt` back to
`lastActivityAt`; `createdAt` is write-only forensics after the read.
Claim/attach inputs carry `lastActivityAt` instead of `updatedAt` (the
restructuring plan line about `ClaimExecutionInput.updatedAt` now reads
`lastActivityAt`). Receipt retention is keyed on the receipt row write time,
and receipt restores strip the two legacy entity timestamp keys so
rolling upgrades tolerate transient pre-migration snapshots (explicit and
bounded, not a compat alias). The session wire DTO and CLI JSON expose
`lastActivityAt` (`last_activity_at`) instead of the two removed fields;
`ApplicationClock`/`SessionClock` keep their shapes for the remaining
meaningful uses. Codex thread recovery bounds dropped the `createdAt` lower
bound (baseline plus ownership checks carry the filtering; unknown tags fail
safe) and kept the `lastActivityAt` upper bound. Residual: auth/tailscale/
codex-state tables keep their own timestamp columns for a later
auth-infrastructure slice.

#### Row↔entity mapping convention

RDB specifics (snake_case columns, `NULL` vs `undefined`, branded-ID
revalidation, conflict targets, timestamp stamping) stay inside each Drizzle
repository file as private `toXRow`/`toXRecord` functions co-located with the
queries that use them, not in a separate mapping directory: every mapper is
used by exactly one file, and partial selects and conflict targets only make
sense next to their queries. The shared idioms are `?? null` on write,
`!== null` spread on read, strict `restore` on rehydration, and explicit
legacy-strip only for transient blobs (receipts). Extract shared mapping
helpers only on the third repeated mechanism, and split out assembly modules
only when aggregates hydrate from joins or multiple stores.

#### Record alias removal (agreed 2026-09-03, executed 2026-09-04)

`WorkspaceRecord`/`PaneRecord`/`AgentSessionRecord` are pure aliases of the
entity classes (`export type WorkspaceRecord = Workspace`). Remove the three
aliases and use the class names everywhere; rename the private mappers to
`toWorkspace`/`toPane`/`toAgentSession` (`toXRow` stays, row types stay).
Contract's wire DTO `AgentSessionRecord` is a separate declaration and stays
untouched. Do this as its own slice after the current batch verifies green so
failures (all loud compile errors) attribute cleanly.

Executed 2026-09-04: aliases deleted, all domain-side usages replaced with
class names, mappers already in `toX` form (no rename needed). Caution found
during execution: `createWorkspaceRecord`/`updateWorkspaceRecord` (factory
function names) contain `WorkspaceRecord` as a substring — they are out of
scope and were kept; a blanket replace touched them once and was reverted.
Prefer exact-token replacement for any follow-up renames.

### Verification status after the domain migration (2026-09-03 session)

`bun install` was run so workspace dependencies resolve again, but no
verification command could be executed from the working agent in this
session: `bun`/`node` execution is blocked by the environment command gate
(`git` still works). The next step must be local verification before any
further slice:

```sh
bun run check:architecture
bun run test:table
bun test
bun run verify
```

Known risk areas to watch in the output: Effect generic inference in
`discriminatedUnion`/`unionCase`/`wire`/`struct`, `.check()` on `Trim`
transforms, `Schema.Union` member typing, `StandardSchemaV1` assignability of
`wire()` results into `oc.input`/`oc.output`/`eventIterator`, `typeof X["Type"]`
drift on renamed schemas, class-instance decoding at oRPC output boundaries,
and readonly `Type`/`Encoded` friction in web/CLI consumers.

After changing code, run at least:

```sh
bun run check:architecture
bun run test:table
bun test
bun run verify
```

The repository may emit an existing `mise` tracking warning and the lint run may report the existing `!important` warnings in `docs/logo-exploration.html`; these are not part of the Effect migration unless the output changes.

### Verification status after the full-migration session (2026-09-04 session)

Execution gate reopened, so the whole tree was verified and fixed. Results:

- `bun run check:architecture`: pass (dependency direction valid).
- `bun run test:table`: pass (116 files).
- `turbo run typecheck`: 16/16 pass.
- `bun run test:local`: 925 pass, 1 skip, 1 fail. The single failure is
  `Web daemon lifecycle > starts reuses and stops one Web process`
  (`packages/infrastructure/src/web-daemon.test.ts`), which spawns a real OS
  process and kills its process group (`kill(-pid)` → EPERM in the sandbox).
  Both files are byte-identical to the base commit and only depend on node
  builtins plus local logging, so this is environmental, not migration-caused.
- `apps/web` vitest: 219/219 pass with `--pool=threads`. The default forks
  pool passes all tests too but its worker teardown (`kill` EPERM) fails in
  the sandbox.
- `bun test scripts/build-muximo.test.ts scripts/profile.test.ts`: 12 pass.
- `turbo run build`: 9/9 pass.
- `bun run audit:public`: pass.
- `bun run lint` (`biome ci .`): clean except the pre-existing
  `docs/logo-exploration.html` `noImportantStyles` warnings noted above
  (file unmodified vs base; left untouched).

Fixes applied during this session (all in the worktree, uncommitted):

- Contract (`packages/contract/src/protocol.ts`): `wire`/`struct` retyped over
  `Schema.Constraint` with an explicit `StandardSchemaV1` return (plus a new
  direct `@standard-schema/spec` dependency for portable declaration emit);
  `unionCase` keeps the tag key literal and tag-first field order (Effect
  encode preserves declaration order; tag-last reordered wire bytes);
  `discriminatedUnion` restored to tag-dispatched decoding via
  `Schema.declareConstructor` + `SchemaParser.decodeUnknownResult` (sync
  `Result` lifted to Effect; same-tag members tried in order, first failure
  surfaces). Plain `Schema.Union` degraded nested issue paths and is not a
  substitute. Restored the accidentally dropped `executionId` on
  `attach_agent_execution` (present in the base Zod schema). Made
  `paneSummarySchema` layout fields optional again to match base (`PaneFields`
  are bare-required; the entity wraps them in `Schema.optional`).
- Domain: `Pane`/`AgentSession.update` operate on `Encoded` snapshots
  (`applyObjectPatch` over `typeof Pane["Encoded"]`); `EntityPatch`
  `RequiredKeys`/`OptionalKeys` rewritten without `{}` (biome
  `noBannedTypes`).
- Daemon `waitForHealthyOrExit`: the exit observation stays on the left of
  both `Effect.race` calls. `Effect.race` resolves simultaneous completions
  left-first, which mirrors the settled-promise-wins semantics of the
  original shared exit promise (`Effect.fork` does not exist in this beta, so
  no fork is used). `Effect.ensuring` finalizers must be infallible, so pane
  release finalizers use `Effect.ignore`.
- `Effect.fn.Return<A, Error>` annotations on `removeResources`/`finalize`
  keep `CleanupResult` literals narrow.
- Zod/Effect boundary: CLI argv schemas keep Zod and must not embed Effect
  schemas (`run.ts` backend → `z.enum(agentBackends)`; `tmux.ts` name → local
  Zod string matching base). Muximod `.parse` leftovers moved to
  `Schema.decodeUnknownSync(..., { onExcessProperty: "error" })`.
- Web/CLI readonly arrays: decoded contract lists are `readonly`; viewmodel,
  view-prop, and selector types were moved to `readonly` (no runtime copies).
- Tests: Promise fakes/awaits on Effect-returning ports converted to
  `Effect.succeed`/`Effect.sync`/`Effect.gen`/`resolveMaybePromise`
  (server, shell, pairing, hooks, observation, muximod-host, worktree,
  flow-store-memory, backend, tmux-host tests); entity spread expectations
  cast to class types; reconcile/session spreads use `.update(clearPatch)`.
- Left intact: `docs/logo-exploration.html` lint warnings and the
  sandbox-blocked process-signal tests above.

### Promise/Effect ownership and per-part wrapping convention (2026-09-04 session)

`fromPromise`/`normalizeError`/`runEffectAsPromise` moved from
`packages/application/src/effect.ts` to
`packages/infrastructure/src/effect.ts` (exported via the `runtime` barrel
and `cli-client`). Application keeps only the `ApplicationEffect` vocabulary
type and is now Promise-free in its own code: Promise interop is not an
application concern. `fromPromise` stays as the single lifting point for
Promise/callback I/O (laziness, AbortSignal threading, Error normalization);
`runEffectAsPromise` keeps its temporary-bridge docstring.

Convention going forward: Effect-ification happens per adapter part, never
ad-hoc per operation. Each port-implementing adapter method is the single
place that lifts its I/O into an Effect; callers compose with `yield*` only.
Banned mid-flow shapes: bare `await` on an Effect value (no-op, invisible to
typecheck), `fromPromise` around an already-Effect value, and
`runEffectAsPromise` anywhere except a true Promise boundary. Legitimate
remaining bridges: transport callbacks that demand `Promise` signatures
(e.g. observation `resolveWorkspace`), the transaction runner (executing
Effects inside a DB transaction is its job), and the muximod/CLI
composition-root facades.

### Thorough pass: sync-throw elimination and failure taxonomy (2026-09-04 session)

- New `attemptSync` helper (`packages/application/src/attempt.ts`): runs sync
  validation (entity `create`/`update`/transitions, id branded constructors,
  name normalization, pid-record reads) inside Effect programs, converting a
  throw into a typed failure instead of a defect. Verified empirically that
  `runPromise` rejects identically for die vs fail, so this is wire-safe; it
  matters for upstream `Effect.catch` recovery regions, which defects bypass.
- Tagged failures: `_tag` added to all error classes (`DaemonHealthError`,
  `ApplicationError`, `ControlFailure` now a class, domain errors,
  workspace/infra errors, `MuximodHttpError`); new `ApplicationFailure`
  (reason union, deliberately codeless) replaced every bare `new Error` in
  application code; domain immutable-guard throws became
  `ImmutableEntityFieldError` with identical messages. `mapError` untouched:
  codeless failures still render as the generic unavailable response, so the
  wire is byte-identical. `failures.test.ts` locks the taxonomy
  (`_tag`/name/code/message per class, codelessness of `ApplicationFailure`).
- Deliberately NOT converted (accepted boundaries, do not "fix" without a
  design change): the Promise-native provider/monitor layer below
  `SessionLauncherPort` (raw process wrangling; lifted once by
  `AgentBackendAdapter`), `AsyncLocalStorage` transaction context, CLI Zod
  argv schemas, `Id.create` defense-in-depth sites already covered by wire
  validation, and full static E-channel narrowing (ports type E as Error by
  construction; narrowing them is a separate port-redesign project).
- Verification: typecheck 16/16, `test:local` 934 pass (only the environmental
  web-daemon kill failure), table rules 117 files, lint clean except the
  pre-existing html file.

## Reference material

These official Effect references explain the primitives used by the migration:

- [`Effect.fn`](https://effect.plants.sh/essentials/effect-fn/)
- [services and layers](https://effect.plants.sh/services-and-layers/services/)
- [testing services](https://effect.plants.sh/testing/testing-services/)
- [TestClock](https://effect.plants.sh/testing/testclock/)
- [acquire/use/release](https://effect.plants.sh/resource-management/acquire-release/)
