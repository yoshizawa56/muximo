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
- `apps/muximod` owns muximod-specific oRPC/HTTP/SSE/WebSocket handlers,
  private control handlers, runtime lifecycle, and dependency injection.
  `apps/muximo-cli` owns CLI argument parsing, command transport, presenters,
  and control-socket clients. Both are outer roots and must call application
  use cases rather than reimplement business rules.
- `apps/*/src/index.ts` may read argv/environment/I/O, select a command,
  construct concrete dependencies, manage lifecycle, and report process-level
  errors. Host integration and infrastructure policy belong in injected
  adapters, not in the entrypoint.
- `apps/web` owns browser clients and route-specific UI. File-based route
  views, view models, and state are colocated with the route; shared
  `components` contain only genuinely generic primitives; do not add a
  feature layer.

## Domain model and patch rules

- Entity modules expose a namespace API such as
  `{ schema, validate, create, update, ...businessOperations }`.
- Creation, update, reconstitution, and domain operations validate their input
  and preserve invariants. Do not construct entity-shaped objects around these
  APIs.
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
  scope. A process-local mutex is not cross-process coordination; direct CLI
  writers still rely on SQLite locking, constraints, conditional updates, and
  transparent busy handling.
- Use explicit transactions only for multiple writes that must commit or roll
  back together. Reads and independent single writes may use autocommit.
  Keep transactions short and database-only.
- Repository persistence reads and writes use Drizzle. Driver-specific SQL is
  limited to connection pragmas and documented migration/bootstrap operations.

## Providers and infrastructure details

Provider-neutral ports remain in application. Provider registries, defaults,
monitors, sidecars, RPC clients, tmux/PTY/process/filesystem adapters,
authentication crypto, logging, Tailscale, and SQLite repositories remain in
infrastructure. Keep implementation-specific invariants in short comments
beside the implementation; do not make a temporary architecture document the
only source of truth.

## Review workflow

Before changing code, identify the layer of every touched module, separate
business decisions from I/O, put abstractions in the inward layer, and wire
concrete implementations at the composition root. Check both imports and
workspace manifest dependencies for reverse edges. Preserve authentication
replay prevention, credential ownership, session claims, worktree containment
and cleanup, hook ordering, provider lifecycle disposal, and tmux identity
reconciliation.

Run `bun run check:architecture` after the change. Test application rules with
fakes and concrete adapters with focused integration tests. Follow the
`table-driven-tests` skill for all behavior test changes.
