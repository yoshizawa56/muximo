---
name: clean-architecture
description: Enforce Muximo's Clean Architecture dependency direction when reviewing or changing domain, application, interface-adapter, infrastructure, composition-root, package, or entrypoint code.
---

# Muximo Clean Architecture

Apply this skill to changes involving package dependencies, layer boundaries,
entrypoints, persistence, host integrations, authentication, transports,
terminal runtime, or the Web UI.

## Dependency direction

Dependencies point inward:

```text
entrypoints/composition roots -> interface adapters and infrastructure
interface adapters -> application and domain
infrastructure -> application and domain
application -> domain and application-owned ports
domain -> no outer packages or runtime adapters
```

The source layer owns its abstractions. A concrete outer implementation may
implement an inward port, but an inward layer must not import the concrete
implementation, its package, or its runtime library.

## Package and responsibility rules

- `packages/domain` contains Zod-backed entities, branded identifiers,
  invariants, and pure business policies. It must not import application,
  contract, infrastructure, Bun/Node, SQLite, Drizzle, tmux, PTY, providers,
  filesystem APIs, transport, or UI code.
- `packages/application` contains application-owned models, ports, and use
  cases. Keep `src/ports`, `src/models`, and `src/usecases` separate; group
  use cases by business domain and keep each use case focused in its own file.
  Application ports are generally async so use cases do not depend on a
  synchronous storage driver. Application must not import `contract` or
  concrete persistence, provider, host, process, socket, or browser adapters.
- `packages/contract` contains shared oRPC contracts, wire schemas, event
  envelopes, and protocol codecs. It may derive, omit, or extend domain types
  from `domain`; it must not duplicate domain business models or depend on
  application, infrastructure, or UI. Infrastructure must never import it.
- `packages/infrastructure` contains concrete implementations of application
  ports and host integrations. Organize it by technical concern and port:
  `persistence/repositories`, `terminal`, `auth`, `agents`, `logging`,
  `tailscale`, and concrete transport adapters such as `http`.
- `packages/muximod` is the only muximod runtime composition root. It owns
  muximod-specific oRPC/HTTP/SSE/WebSocket handlers, private control handlers,
  runtime lifecycle, persistence composition, snapshot/bootstrap, and daemon
  resource cleanup. There must be no `apps/muximod` entrypoint.
- `apps/muximo-cli` and `apps/web` are daemon clients. They interact with
  daemon-owned state only through the typed API/control contracts. The CLI may
  use the private control contract because it runs locally and is in the local
  trust boundary; that does not permit direct database, repository, schema,
  log-file, or other daemon-state access.
- CLI production code imports host capabilities through the narrow
  `@muximo/infrastructure/cli-client` surface and imports lifecycle/path
  utilities through `@muximo/muximod/client`. It must not import the full
  infrastructure or muximod package surfaces, which expose daemon-only
  persistence and process-bootstrap capabilities.
- Daemon composition uses the explicit `@muximo/infrastructure/runtime` and
  `@muximo/muximod/runtime` surfaces. The package root exports are absent on
  purpose; a client must not regain daemon internals by changing only an
  import path.
- `apps/muximo-cli` owns argv/environment parsing, client request mapping,
  presenters, host-only process/Git/tmux/shell operations, and the client-side
  daemon process bootstrap adapter. It must never open SQLite, construct a
  Drizzle repository, run schema synchronization, perform snapshot copying, or
  reimplement a daemon use case. Any daemon data needed by a host operation
  must first be obtained through the API or private control contract.
- Both client apps are outer roots and must call typed contracts rather than
  importing daemon persistence or application implementations.
- `apps/*/src/index.ts` may read argv/environment/I/O, select a command,
  construct concrete dependencies, manage lifecycle, and report process-level
  errors. Host integration and infrastructure policy belong in injected
  adapters, not in the entrypoint.
- `apps/web` owns browser clients and route-specific UI. File-based route
  views, view models, and state are colocated with the route; shared
  `components` contain only genuinely generic primitives; do not add a
  feature layer.

## Domain model and patch rules

- Entity modules expose a namespace API such as `{ schema, create, restore, update, ...businessOperations }`.
- `create` builds new aggregates, `restore` rehydrates persisted data, and `update` applies pure transitions.
  Repositories and adapters must rehydrate through `.restore(...)`; there is no public `.validate(...)`
  so raw objects cannot be legitimized after construction.
- Creation, update, reconstitution, and domain operations validate their input and preserve invariants. Do not construct entity-shaped objects around these APIs; do not call `<Entity>.schema.parse` outside the domain or contract packages (`check-architecture` enforces both).
- Domain schemas use optional properties for absence and do not use nullable
  fields. A transport PATCH interprets `undefined` as unchanged and `null` as
  clear; the outer adapter maps that representation to the domain patch type.
- Database `NULL` is converted at the infrastructure boundary. It must not
  leak into domain or application models.

## Transport and authentication

- Use oRPC directly; do not add a Hono wrapper solely to host oRPC.
- oRPC handles request/response calls. Typed SSE carries best-effort events
  that may be missed and do not require replay. WebSocket is limited to
  interactive terminal data and control messages.
- `contract` owns wire validation and WebSocket control-frame encoding and
  decoding. PTY terminal bytes remain raw `Uint8Array` data; do not duplicate
  protocol JSON parsing in apps or infrastructure.
- Transport middleware performs origin, credential, session, and endpoint
  ticket checks before application calls. Preserve pairing proof/approval,
  credential ownership, one-use endpoint-bound WebSocket tickets, and
  secret-free logs.

## SQLite transaction rules

- Keep application and repository interfaces async, but remember that Bun's
  SQLite calls are synchronous and can block the event loop.
- Never pass an async callback to Bun's synchronous
  `Database.transaction(...)` API or to an equivalent Drizzle callback API.
- The permitted async transaction scope is an explicit infrastructure
  implementation using a dedicated connection, process-local serialization,
  `BEGIN IMMEDIATE`, ambient transaction context, and whole-scope rollback and
  retry. Its callback is a DB-only scope: repository and database-audit calls
  are allowed; network, PTY, tmux, provider, filesystem, authentication
  service, and other external side effects are not.
- The transaction connection and root/autocommit connections are distinct.
  Code must not write through a root connection from an active transaction
  scope. The daemon is the only process allowed to access its database; client
  processes must use API/control contracts instead of relying on SQLite
  locking, constraints, or conditional updates directly.
- Use explicit transactions only for multiple writes that must commit or roll
  back together. Reads and independent single writes may use autocommit.
  Keep transactions short and database-only.
- Repository persistence reads and writes use Drizzle. Driver-specific SQL is
  limited to connection pragmas and documented migration/bootstrap operations.

## Providers and infrastructure details

Provider-neutral ports remain in application. Provider registries, defaults,
monitors, sidecars, RPC clients, tmux/PTY/process/filesystem adapters,
authentication crypto, logging, Tailscale, and SQLite repositories remain in
infrastructure. Persistence implementations may be composed only by
`packages/muximod`; a CLI host adapter must use a daemon contract instead of a
persistence adapter. Keep implementation-specific invariants in short
comments beside the implementation; do not make a temporary architecture
document the only source of truth.

## Daemon client boundary

The daemon is the single source of truth for all durable and runtime-managed
state. This is an absolute boundary, not a preference that can be relaxed for
host-local commands:

- `packages/muximod` is the only package allowed to instantiate the daemon
  database, schema synchronizer, Drizzle repositories, database transaction
  manager, or lossless snapshot implementation.
- CLI and Web code must not import persistence modules, open a SQLite file,
  query daemon tables, or read daemon-owned log/state files directly.
- API contract operations are used for normal daemon commands. Private control
  contract operations are used for local-only capabilities such as session
  token minting, pairing, pane control, and other operations that must not be
  exposed publicly.
- A local Git, tmux, shell, or process operation is allowed only when its
  inputs come from CLI arguments, the local host, or a daemon contract response.
  It must not obtain daemon state through a second local repository.
- If a client needs information or an operation that is not represented by a
  contract, extend the appropriate contract and implement it in the daemon.
  Do not add a client-side persistence shortcut.
- Process creation before a daemon is running is a lifecycle/bootstrap concern,
  not a second daemon implementation. The bootstrap adapter may start or stop
  the private process, but all daemon state remains behind the daemon package
  and its contracts.

## Review workflow

Before changing code, identify the layer of every touched module, separate
business decisions from I/O, put abstractions in the inward layer, and wire
concrete implementations at the composition root. Check both imports and
workspace manifest dependencies for reverse edges. For every CLI change,
search for SQLite, Drizzle, persistence repositories, schema synchronization,
and direct daemon-state file reads; all such access must remain in
`packages/muximod`. Preserve authentication
replay prevention, credential ownership, session claims, worktree containment
and cleanup, hook ordering, provider lifecycle disposal, and tmux identity
reconciliation.

Run `bun run check:architecture` after the change. Test application rules with
fakes and concrete adapters with focused integration tests. Follow the
`table-driven-tests` skill for all behavior test changes.
