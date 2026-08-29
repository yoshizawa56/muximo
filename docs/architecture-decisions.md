> [!NOTE]
> This record was written before the 2026-08-23 restructuring pass.
> Package/file layouts described here superseded by
> `docs/architecture-restructuring-plan.md`; principles still apply.

# Muximo Architecture Decisions

Status: working design memo for review.

This document records the architecture decisions made during the current
Clean Architecture review. It describes the target structure, not the current
state of every file. A later implementation change must preserve the rules
below or document an intentional exception.

## Design goals

- Limit each module's concern so that it can be tested in isolation.
- Keep business rules independent of Bun, Node.js, SQLite, tmux, PTY, agents,
  transports, and browser APIs.
- Keep composition roots responsible for dependency injection and process
  lifecycle, not business workflows.
- Prefer a small number of meaningful packages and directories over many
  technology-shaped packages.
- Make protocol boundaries explicit and runtime-validatable.
- Keep tests deterministic, declarative, and close to the behavior they verify.

## Target package structure

The target workspace package set is intentionally small:

```text
packages/
  domain/
  application/
  contract/
  infrastructure/
  muximod/
  test-support/

apps/
  muximo-cli/
  web/
```

`packages/muximod` owns the muximod runtime and its lifecycle composition. It
is not a user-facing CLI and has no `apps/muximod` counterpart. There should
not be separate `muximod-*`, `protocol`, or Hono wrapper packages merely to
split transport technologies. A package is justified by a stable
architectural boundary, not by the number of files in a directory.

The wire-schema package is referred to as `contract` in this document. The
repository should not use both `api` and `contract` for the same responsibility.

## Dependency direction

Dependencies point inward:

```text
apps/* (composition roots)
  -> infrastructure
  -> contract
  -> application
  -> domain

infrastructure -> application and domain
application     -> domain and application-owned ports
contract        -> domain
domain          -> no outer package or runtime adapter
```

The source layer owns its abstractions. Infrastructure implements application
ports; application does not import infrastructure implementations or runtime
libraries. Domain models are the source of truth for business concepts.

`contract` may derive wire types from domain objects with `Pick`, `Omit`,
extensions, or explicit protocol wrappers. It must not independently recreate
the same business model and allow the two definitions to drift.

The exact composition boundary between `contract` codecs and concrete HTTP or
WebSocket adapters still needs implementation-level review. The constraints
are non-negotiable:

- The protocol codec is owned by `contract`.
- Application and domain must not depend on transport schemas.
- Infrastructure must not import `contract` merely to obtain business rules.
- No application or app module may duplicate byte, text, or wire decoding
  logic.

If a transport adapter needs a codec, the composition root or a deliberately
outer adapter must connect those pieces without reversing the dependency
direction.

## Domain

`packages/domain` contains entities, value objects, invariants, and pure
policies. It must not import HTTP, WebSocket, CLI, Bun, Node.js, SQLite,
Drizzle, tmux, PTY, agent providers, filesystem APIs, or UI code.

Entities are Zod-backed namespace values. Each entity exposes `schema`,
`create`, `restore`, `update`, and predicates as appropriate. `create`
normalizes and validates new input, `restore` reconstitutes persisted data,
`update` validates the current entity and the resulting entity, and every
persistence reconstitution path restores the database row before returning it.
No application or adapter code may construct an entity-shaped object and
bypass these boundaries. An entity that crosses a domain boundary is
therefore always structurally valid and invariant-safe.

Domain optional properties use `undefined`; `null` is a transport or database
representation only. Transport PATCH schemas use omitted/`undefined` for
"keep" and `null` for "clear". The outer adapter maps that representation to
the domain `Patch` type before invoking a use case. Entity identifiers are
branded domain types; protocol schemas validate plain wire strings and map
them at the boundary.

Domain behavior should remain synchronous when it is pure computation. It
should not become asynchronous just because an outer repository happens to be
asynchronous.

## Application

`packages/application` contains use cases, application-owned input/output
models, and ports.

The package should be organized by responsibility rather than kept flat:

```text
application/src/
  ports/
    repositories/
    agents/
    terminal/
    events/
    transactions/
  usecases/
    auth/
    workspaces/
    sessions/
    panes/
    pairing/
```

The exact domain directory names may follow the actual use-case vocabulary,
but each use case should have a focused file and its related use cases should
be grouped by domain. Ports and use cases must not be mixed in one flat
directory. Application-owned boundary data lives with the relevant port or use
case; a generic `models/` directory is not used.

Repository and gateway ports belong to application because the use cases own
the required abstractions. Their public methods should generally be
asynchronous so the application is not coupled to a synchronous storage
implementation. This is an interface decision, not a claim that every
implementation is non-blocking.

## Contract and transports

`packages/contract` owns protocol schemas, request/response contracts, event
envelopes, and protocol codecs. Runtime validation belongs at this boundary.

Hono is retired. The API is exposed through oRPC directly; there is no Hono
wrapper solely to obtain routing or RPC typing.

The transport split is:

- oRPC handles request/response calls.
- SSE carries lightweight, lossy invalidation or status events. Events are
  allowed to be missed and do not require replay.
- The event payload remains a typed contract. TypeScript types alone are not
  runtime validation; the wire schema must validate incoming and outgoing
  data.
- WebSocket is reserved for interactive terminal communication and its
  control messages. PTY input/output remains raw `Uint8Array` data; it is not
  converted into a domain entity.
- Text WebSocket control frames have typed protocol schemas. Binary/text
  encode/decode behavior belongs to `contract`, not to an app entrypoint.
- Unrelated application events should not be multiplexed into the terminal
  byte stream when SSE is sufficient.

The ownership split is deliberately explicit:

- `packages/contract` defines the shared schemas, oRPC contract, and protocol
  codecs only.
- `packages/muximod/src/http` owns the muximod-specific oRPC handler, HTTP
  endpoint policy, authentication context, SSE subscription, and WebSocket
  upgrade wiring.
- `packages/muximod/src/control.ts` owns the muximod-specific private IPC
  handler, because it interprets the contract and invokes application ports.
- `packages/contract/api`, `packages/contract/control`, and
  `packages/contract/shared` expose explicit audience-specific contract
  surfaces. API consumers do not need to know the private socket protocol.

`packages/muximod/src/server.ts` is the runtime composition root. It injects
infrastructure implementations into the application and then injects that
application into the HTTP and private control transports. The package exposes
typed lifecycle operations through `launch.ts`; the separate child process is
started through its private process bootstrap. The handler is not exported from
the CLI-facing infrastructure package surface. Daemon composition imports the
explicit `@muximo/infrastructure/runtime` surface; CLI composition imports only
`@muximo/infrastructure/cli-client` and `@muximo/muximod/client`. The package
root exports are intentionally absent so the two audiences cannot silently
share the same broad import surface.

## Infrastructure

`packages/infrastructure` contains concrete adapters and host integrations.
It is organized by technical concern and by the port it implements, so the
implementation of a port is easy to locate:

```text
infrastructure/src/
  persistence/
    repositories/
      sqlite/
  agents/
  http/
  terminal/
  logging/
  tailscale/
  auth/
```

The final directory names may be adjusted to the actual port names, but
implementations must not remain in an unrelated flat directory. Provider
implementations, PTY/tmux integrations, SQLite/Drizzle repositories,
filesystem/process access, logging, authentication crypto, and host commands
belong here.

The repository implementation directory is called `repositories` when it
contains application repository port implementations. `persistence` is only
appropriate as a broader technical grouping if it contains more than
repositories, such as migration and database lifecycle code.

Provider-neutral ports remain in application. Provider-specific registries,
default provider lists, monitors, sidecars, and RPC clients remain in
infrastructure and are registered by a composition root.

CLI transport definitions are app-owned. `apps/muximo-cli/src/cli` contains
argument parsing, command dispatch, presenters, and the private control
socket client. It may call application use cases and injected infrastructure
adapters, but no CLI handler is exported by `infrastructure`.

## Composition roots and CLI

`apps/muximo-cli/src/entrypoint.ts`, `apps/muximo-cli/src/cli/compose.ts`,
`apps/web/cli.ts`, and `packages/muximod/src/server.ts` are composition roots for
their respective boundaries. These
composition roots may:

- read argv and environment variables;
- select a command or runtime profile;
- construct concrete infrastructure adapters;
- inject dependencies;
- start and stop the process;
- report process-level errors.

They must not contain business workflows, repository policy, provider policy,
or protocol implementation.

CLI command transport definitions and argument mapping may be kept in the CLI
adapter boundary because the CLI is not shared with the web API. They must
still call application use cases and must not reimplement business behavior.
If a CLI adapter becomes shared, move it to the infrastructure CLI adapter
area rather than adding a second use-case implementation.

Normal workspace and agent-session CLI commands call the muximod API over
local HTTP using a short-lived local token minted through the private control
socket. Pairing and host-only pane control use the private socket directly;
starting, stopping, and restarting muximod call the typed package lifecycle
locally. The CLI may still run host integrations such as tmux, Git, shell, and
doctor directly, but those integrations may use only command input, local host
state, or data returned by a daemon contract. They must never open the daemon
database, read daemon-owned log/state files, or construct a second repository
view. If a client needs another daemon value, the contract is extended and the
daemon remains the only implementation of the read or write.

The daemon is the single writer and source of truth for durable and
runtime-managed state. An in-process mutex in `muximod` therefore cannot
provide a global serialization guarantee by itself; the daemon's database
transactions and private control contract provide the cross-process boundary.

## Muximod lifecycle and environment topology

`packages/muximod` owns the typed lifecycle API exposed to the CLI:
`ensure`, `start`, `startForeground`, `status`, `stop`, and `restart`. It also
owns the child-process bootstrap, PID and restart markers, schema synchronization,
and cleanup of muximod resources. A private process bootstrap is used for the
separate runtime process; it is an internal package implementation detail, not
a hidden or public CLI command.

The CLI resolves all Muximo configuration before calling that lifecycle API. The
source/development CLI's `--env <name>` profile selects one state root and its
configured ports. The standalone production CLI uses the fixed `prod` environment
and does not load source repository profiles. Every selected profile defaults to
`migrate`; `push` is selected only by an explicit `MUXIMO_SCHEMA_MODE=push` value.
Worktrees do not derive state directories and no snapshot, seeding, or
base-instance copy is performed.

`apps/web/cli.ts` independently manages one Web process per environment and its
provider route. It does not import or invoke muximod. Muximod Serve only manages the
muximod route. The two lifecycle surfaces share only raw profile loading and
neutral Tailscale provider mechanics; each app interprets its own environment
values and neither is a combined supervisor.

## Web structure

The Web UI is route-driven and colocated:

- file-based routes own their page view, route-specific view model, and
  route-specific state;
- page-specific UI must not be moved into a `features` directory;
- `features` is fully retired;
- only genuinely generic primitives, such as buttons, belong in shared
  `components`;
- terminal UI belongs beside the route that renders it, not in a global
  `terminal` feature package;
- the browser oRPC client may live at the app level because it owns browser
  `fetch`, `WebSocket`, and connection state.

Each page view should have a current Storybook story that covers meaningful
empty, loading, error, boundary, and populated states. Stories should use
`play` interactions to verify view behavior. Stale stories should be
deleted instead of retained as historical snapshots.

## Authentication and middleware

Authentication is an adapter boundary, not a business workflow hidden inside
the entrypoint. Transport middleware performs request-origin, credential, and
session-ticket checks before invoking application use cases. Credential
ownership, pairing, session claims, replay prevention, and authorization rules
remain explicit and testable; sensitive values must not enter logs.

Middleware may construct request context and reject invalid requests, but it
must not become a second application service layer or contain persistence
policy.

## SQLite and transaction policy

SQLite is an embedded, synchronous database API in Bun. An asynchronous
application or repository interface is still preferred, because it keeps the
application independent from the storage driver and permits a later Worker or
different driver implementation. The async interface does not by itself make
the current synchronous SQLite call non-blocking.

The current consistency policy is deliberately modest:

- reads do not need an explicit transaction;
- single-row or otherwise independent writes do not need an explicit
  transaction;
- use a transaction only when multiple writes must succeed or fail together;
- keep such transactions short and database-only;
- do not hold a SQLite transaction across PTY, tmux, network, or other
  external I/O;
- use database constraints or conditional updates for important
  read-modify-write races;
- do not require strict application-wide serializability when stale reads and
  independent updates are acceptable.

Consistency is selected per operation, not globally:

| Data or operation | Required protection |
| --- | --- |
| Read-only views and pane observations | No explicit transaction; stale data may be repaired by reconciliation |
| Append-only audit or event records | Single atomic insert; no cross-record snapshot required |
| Independent single-row writes | Autocommit and database constraints |
| Multi-row lifecycle changes | One short transaction |
| Claims, pairing approval, revocation, and ownership transitions | Conditional update and/or transaction; lost updates are not acceptable |
| Read-modify-write where last-writer-wins is unacceptable | Version/revision predicate or transaction |

Allowing stale observations does not allow malformed durable state, lost
security transitions, or partial lifecycle records. When last-writer-wins is
acceptable, a single-statement idempotent upsert is preferable to introducing a
global application lock.

The `TransactionManager` mutex is a process-local safety mechanism for
transactions sharing one connection or one transaction resource. It is not a
cross-process lock and must not be treated as the source of global data
consistency. The daemon is the only database writer, so SQLite's writer lock
and transaction policy stay behind the daemon boundary; clients must use its
contracts instead of opening competing connections.

SQLite still provides atomic commit for the statements inside one transaction.
The issue is not that SQLite cannot preserve atomicity; the issue is safely
owning one connection and transaction across asynchronous application code.

`TransactionManager` remains an application-owned port for the use cases that
need multi-write atomicity. The infrastructure implementation must not expose
SQLite details to the application. `AsyncLocalStorage` may hold the ambient
transaction context, and a repository base may select the ambient executor or
the root executor, but context propagation is not a substitute for
serialization or ownership.

The direct `bun:sqlite`/Drizzle implementation must not use an `async`
transaction callback with a synchronous transaction API. Until database access
is moved to a Worker or a truly async-capable driver, transaction scopes must
be implemented as short, explicitly controlled database sections. A Worker is
an optimization to introduce if event-loop delay measurements show that
synchronous SQLite calls are material in production.

Busy handling is an infrastructure concern and must be transparent to
application use cases and daemon clients:

- configure a busy timeout for every SQLite connection in the daemon database
  factory;
- acquire a write transaction up front, preferably with `BEGIN IMMEDIATE`, so
  lock failure happens before business mutations when possible;
- when a retryable busy error still occurs, rollback and retry the complete
  database-only transaction with bounded backoff and jitter;
- never retry an individual statement from the middle of a transaction;
- do not retry constraint, authorization, corruption, disk-full, or other
  non-transient errors;
- do not automatically retry a scope containing external side effects;
- after the retry budget is exhausted, expose one infrastructure error and let
  the outer adapter report it normally.

The process-local transaction mutex remains useful for same-process connection
ownership. CLI processes do not open SQLite connections; they observe and
mutate state through daemon contracts, so the daemon owns all database lock and
retry behavior.

## Database tests

Database table tests should avoid running migrations for every row:

1. Create an isolated database and run the current migrations once per test
   suite or worker.
2. For each table row, open a transaction.
3. Create the complete fixture inside that transaction.
4. Execute the operation.
5. Observe state through read-only APIs inside the same transaction scope.
6. Run named assertions and aggregate row failures.
7. Roll back the transaction after the row.

The shared table-test runner should provide a case scope that wraps fixture,
execution, observation, assertions, and rollback. External resources still
need explicit cleanup after the database scope. Tests that exercise migration
discovery or a deliberately pending schema remain separate and may use their
own database lifecycle.

All table tests should use typed declarative rows, complete fixture selection,
shared execution, post-execution observation, named assertions, and aggregate
failure reporting. Database rows should run serially unless isolation has been
proven.

The test transaction implementation must respect the same limitation as the
production Bun adapter: it must not pretend that a synchronous SQLite
transaction callback safely supports arbitrary `await` operations.

## Review items

The following details remain implementation-level review points rather than
permission to violate the rules above:

- the exact outer composition boundary that connects `contract` codecs to
  HTTP/WebSocket adapters without introducing a reverse dependency;
- whether unshared CLI command definitions live in `apps/muximo-cli` or the
  infrastructure CLI adapter;
- the concrete `TransactionManager` implementation for synchronous Bun
  SQLite;
- event-loop delay measurements that determine whether a SQLite Worker is
  warranted;
- the final route-by-route Web Storybook coverage and stale-story deletion.
