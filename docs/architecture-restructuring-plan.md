# Architecture Restructuring Plan (working handover)

This memo tracks the agreed target structure and the remaining phases of the
Clean Architecture consolidation. Rules here are binding; deviations require
updating this file in the same change.

## Binding placement rules (enforced unless noted)

- `packages/domain`: flat. Entity namespaces (`workspace.ts`, `pane.ts`,
  `agent-session.ts`) own their rules; shared mechanisms are `ids.ts`
  (branded identifiers), `patch.ts` (update vocabulary: undefined=keep,
  null=clear), `auth-protocol.ts` (canonical signed messages).
  New domain files only for new entities or mechanisms referenced by >=2
  existing domain files.
- Entities expose only `schema`, `create`, `restore`, `update`, predicates.
  `.validate` was removed on purpose; `<Entity>.schema.parse` outside
  domain/contract is banned (check-architecture enforces both).
- `packages/application`: `ports/<aggregate>.ts` = interfaces plus the data
  types those interfaces own. `usecases/<domain>/<verb>.ts` = exactly one
  use case per file with explicitly injected deps; its input/output types are
  exported from that file. `models/` is abolished (check-architecture bans
  reintroduction). Application stays stateless: mutable flow state becomes a
  port implemented by infrastructure.
- `apps/*` are thin transport layers: handler assignment per contract +
  composition-root DI only. Concrete implementations belong to
  `packages/infrastructure`.
- `apps/web/src/app/api` is frozen at the current seven files; new concerns
  go to routes or contract.
- Tooling: Biome (lint=0 gate), lefthook pre-commit (biome + architecture),
  `bun run test:local` scans source dirs only (never `packages` broadly;
  stale `dist/**` must never execute).

## Completed

- oRPC contract package rename; web query keys derived from contract with a
  central invalidation matrix; raw query-key literals banned in web app code.
- Domain entities as Zod namespaces with create/restore/update.
- application/src/models abolished; types redistributed mechanically.
- Workspace CRUD split one-use-case-per-file
  (list/register/update/delete + record-factory/errors/find-workspace).
- Infrastructure AuthService subclass removed; composition roots inject
  `nodeAuthCrypto` directly.
- Biome + lefthook installed; test preload sets NO_PROXY for local servers.

## Phase 1c — DONE — dissolve `usecases/muximod/muximod-service.ts` (528 lines)

Target files (all under `usecases/<domain>/`, one operation each, deps
injected; keep `createMuximodApplication` in place as the pure assembler that
builds the `MuximodApplication` facade from these instances):

- `usecases/terminals/reconcile-panes.ts` (from syncPanes/reconcile paths)
- `usecases/sessions/create-session.ts` (CreateSessionInput lives here)
- `usecases/sessions/list-sessions.ts` (produces MuximodSessionSummary[])
- `usecases/agents/adopt-agent-session.ts`
- `usecases/agents/observe-agent-session.ts`
- `usecases/agents/release-agent-session.ts`
- `usecases/sessions/agent-status.ts` already exists; the in-process
  `AgentStatusStore` map is constructed by the composition root and injected
  (no new class needed).

Rules: no behavior changes; facade method signatures stay identical so
`packages/muximod/src/http` keeps compiling. Tests move beside their use case.

## Phase 1d — DONE — decompose `usecases/auth/auth-service.ts` (285 lines)

1. Define flow-state ports in `ports/auth.ts` (names indicative): pending
   pairing attempts, challenges, one-use WS tickets — each with TTL sweep.
2. Implement in `infrastructure/src/auth/flow-store-memory.ts` (Maps +
   timer-based sweep; composition root starts/stops it).
3. Split operations into `usecases/auth/*.ts`: start-pairing, claim-pairing,
   approve-pairing, create-challenge, create-session, issue-ticket,
   consume-ticket. Each takes (store ports, crypto port, clock) via deps.
4. Keep replay/rate-limit behavior identical; service.test scenarios move to
   the new files (or stay as one lifecycle scenario under usecases/auth/).

## Phase 2 — DONE — move muximod into its package

`apps/muximod` was removed. The muximod runtime, HTTP transport, private
control socket, process bootstrap, and lifecycle composition now live in
`packages/muximod`:

```
packages/muximod/src/index.ts              internal aggregate exports
packages/muximod/src/client.ts             CLI-facing lifecycle/path exports
packages/muximod/src/runtime.ts            daemon runtime exports
packages/muximod/src/launch.ts             typed lifecycle and process bootstrap
packages/muximod/src/process-entrypoint.ts private child-process bootstrap
packages/muximod/src/process-files.ts     PID and restart marker ownership
packages/muximod/src/entrypoint.ts         private runtime process entrypoint
packages/muximod/src/server.ts             runtime composition root
packages/muximod/src/http/                API, events, and terminal transport
packages/muximod/src/control.ts           private Unix-socket control transport
```

`packages/muximod` is the only owner of muximod DI, child-process creation,
PID/restart files, schema synchronization, and runtime resource cleanup. Its
private process bootstrap receives a validated typed launch payload through an
internal process-boundary serialization; it is not a public CLI command and is
not present in help or completion.

The API and private control-socket surfaces have separate contract exports:
`@muximo/contract/api`, `@muximo/contract/control`, and
`@muximo/contract/shared`. HTTP exposes browser operations; pairing and host
control remain on the private Unix socket. Only the minimal pairing values are
shared between those surfaces.

## Phase 3 — DONE — CLI decomposition and daemon-client boundary

The CLI now has one explicit boundary, `createCliApp(deps)`, and one concrete
composition root, `apps/muximo-cli/src/cli/compose.ts`. Commander owns the complete
command tree, while each command module validates Commander values with Zod and calls
one typed handler. The entrypoint owns only argv, environment, streams, invocation,
error reporting, and exit status. The CLI is a pure daemon client for daemon-owned
state: it does not open SQLite, construct repositories, synchronize schemas, copy
snapshots, or read daemon log/state files.

Application lifecycle policy is split into `RunAgentSession`, `ResumeAgentSession`,
`ListAgentSessions`, `CleanupAgentSession`, and `LocateAgentSession`. Their focused ports
are provider-neutral and asynchronous for filesystem, Git, process, and observation I/O.
Launch plans return typed session updates and own exactly-once disposal. Resume claims
receive an application-generated `ClaimExecutionInput.updatedAt`.

Concrete CLI capabilities live under `packages/infrastructure/src/cli/`: backend
launch/discovery, worktrees, hooks, panes, workspace, observations, shell, tmux sessions,
serve, and diagnostics. The shared profile package loads the selected raw
profile, while each application resolves its own environment semantics. The
neutral Tailscale provider adapter remains in infrastructure.
Muximod lifecycle, persistence, bootstrap, and timing adapters live under
`packages/muximod`; the CLI composition root selects the configured `migrate` or
explicit `push` schema mode. Pairing UI and control-socket clients remain CLI-local
adapters.
Normal workspace and agent-session operations use the typed
API over local HTTP after minting a short-lived local token through the private control
socket. Browser origins are normalized and passed exactly to daemon options; wildcard
origins are rejected.

The former host/runtime directories, engine/lifecycle façade classes, broad session host
port, manual parser paths, and direct CLI implementations of daemon-backed workspace and
agent-session workflows are removed. Provider implementation metadata is persisted
through infrastructure-owned state rather than domain record mutation. Application
results are typed business outcomes; CLI presenters own messages and process status
mapping. If a client needs another daemon value or operation, the API or private control
contract is extended and the implementation remains in muximod; a local persistence
shortcut is not permitted.

The selected `--env <name>` profile determines the shared environment state directory
and its configured local/external ports. No profile name has special behavior: the CLI
schema mode defaults to `migrate`, and a profile must explicitly set
`MUXIMO_SCHEMA_MODE=push` to select push. No worktree-specific database, snapshot,
seeding, or Portless URL is used. `apps/web/cli.ts` independently manages one Vite process
and its Web Serve route; it does not import or invoke muximod. Muximod Serve is a separate
route-only command, and no combined development supervisor is part of the runtime.

## Verification per phase

```
bun run lint
node scripts/check-architecture.mjs
bun run test:local
per-package typecheck sweep
```

Known environment note: proxied sandboxes need NO_PROXY for localhost server
tests; `scripts/test-preload.ts` handles it via bunfig preload.
