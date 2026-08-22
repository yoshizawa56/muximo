---
name: table-driven-tests
description: Enforce deterministic table-driven testing for this TypeScript, Bun, and Vitest repository. Use when creating, modifying, reviewing, or refactoring any *.test.ts, *.test.tsx, or *.test.mjs file. Require typed declarative rows, complete fixture selection, shared execution, post-execution observation, named assertions, and aggregate failure reporting.
---

# Table-Driven Tests

Apply these rules to every `*.test.ts`, `*.test.tsx`, and `*.test.mjs` file. A one-case behavior test is still a one-row table. Storybook stories are excluded unless they contain executable test cases.

## Repository source of truth

- Use `packages/test-support` for shared table runners, outcomes, fixtures, cleanup, and assertion helpers.
- Run `scripts/check-table-tests.mjs`; do not create a local runner or assertion convention in an individual test file.
- Follow neighboring tests and the current package exports when applying these rules. Do not rely on deleted or external architecture documents.

## Table shape

- Use `runOperationTable` when every row performs one public operation with the same completion and cleanup policy.
- Use `runScenarioTable` for a typed multi-step protocol such as WebSocket reconnect, CLI run/resume/cleanup, or tmux attach/detach.
- Use `describe` only to group related tables. Do not use bare `it(...)`, `test(...)`, or `describe.each(...)` for behavior tests.
- Keep rows declarative and typed. Each row may contain only `name`, optional `fixture`, `input`, optional data-only `steps`, and a non-empty `assert` list.
- Give every row a unique, behavior-oriented `name`. Do not put execution, setup, observation, delays, mock implementations, or lifecycle control in a row.

Prefer `satisfies readonly OperationCase<...>[]` or `satisfies readonly ScenarioCase<...>[]` for case tables and explicit types for the table passed to the shared runner.

## Fixtures and lifecycle

Treat a fixture as the complete test world: the system under test, injected doubles, clocks, databases, filesystems, sockets, ports, environment state, initial data, and cleanup registrations.

- Make the default fixture lazy and fresh for every row.
- When a row specifies `fixture`, select only that complete fixture; do not eagerly create or merge the default fixture.
- Keep dependency differences in fixture variants, not in `input` or branches inside `execute`.
- Fixture setup may arrange state and register cleanup, but must not perform the public operation under test.
- Use one shared execution shape: select fixture, execute, capture `Outcome`, observe, run every assertion, and clean up in `finally` using reverse registration order.
- Capture only errors thrown by `execute`. Fixture setup and observation failures are infrastructure failures, not expected domain outcomes.

Use this outcome shape for normal and error cases:

```ts
type Outcome<Result> =
  | { ok: true; value: Result }
  | { ok: false; error: unknown };
```

## Observation and assertions

Define one post-execution `observe` function per table. It may read spies, fake call logs, event buffers, state snapshots, response bodies, and database effects, but it must not call the system under test, advance time, emit events, or consume a stream destructively.

Install subscriptions, spies, and recorders during fixture construction so execution-time events are not missed. Pass the same observed context and `Outcome` to every assertion.

- Every row must have a non-empty list of named assertions.
- Run all assertions for a row and aggregate failures; do not stop at the first failure or use concurrent `Promise.all` for assertions.
- An unexpected execute error fails the row automatically. Mark an expected execute error with `hasError(...)` or a custom assertion with `allowsOutcomeError: true`.
- Prefer `hasNoError()`, `returns(...)`, `hasError(...)`, `hasObserved(...)`, `hasCalls(...)`, and `hasEvents(...)` from `packages/test-support`.
- Use one assertion entry for one logical expectation. Assertion names must be non-empty and unique within a row.
- Custom assertions must be named and read-only; they must not call the system under test, mutate fixtures, advance clocks, emit events, or clean up.

## Domain-specific cases

- HTTP tests use typed request data; the shared executor constructs, dispatches, and parses requests once. Keep malformed input, domain errors, and success rows together when their execution path is identical.
- Inject clocks and schedulers. Represent timer advancement and retry completion as typed scenario steps; do not use arbitrary sleeps or row-specific timeout callbacks.
- For streams and WebSockets, subscribe in the fixture and let the common executor drive the protocol to a defined terminal condition. Observation only reads captured events.
- Use complete replacement fixtures for empty, seeded, legacy, migration, and reopen database states. Tables touching global state, ports, processes, filesystem paths, or databases run serially unless isolation is proven.
- Integration tests keep capability checks, suite-level timeouts, and concurrency policy outside rows and use condition-based waiting.

## Database table scopes

Database table tests must not run migrations for every row. Use the shared
database table-scope helper when available:

- create an isolated database and apply the current migrations once per suite
  or worker;
- open one explicit transaction scope per row;
- run fixture setup, execute, observation, and assertions inside that scope;
- roll back the scope after every row, including assertion and execute errors;
- run external-resource cleanup after the database rollback;
- keep database rows serial unless independent isolation has been proven.

The scope must use the same safe transaction shape as production SQLite:
explicitly controlled `BEGIN IMMEDIATE`/rollback/commit on a connection owned
by the scope. Do not pass an async callback to Bun's synchronous
`Database.transaction(...)` API. A test scope must not hide network, PTY,
tmux, provider, or other external side effects inside a transaction retry.

## Validation

Before completing a test change:

1. Enumerate all affected test files and choose an operation or scenario table for each.
2. Run `bun run test:table`.
3. Run the relevant package tests and `bun run typecheck`.
4. Run the complete `bun run test` suite.

Do not complete the change while a behavior test uses a bare test block, an untyped table, a per-row executor, an empty assertion list, or an unreviewed escape hatch.
