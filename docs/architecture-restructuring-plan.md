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
`apps/muximod/src/http` keeps compiling. Tests move beside their use case.

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

## Phase 2 — DONE — slim apps/muximod

Allowed final set:

```
src/index.ts            process entrypoint (argv branch only)
src/server.ts           composition root (only place constructing adapters)
src/http/app.ts         transport assembly (~150 lines target)
src/http/rpc-handlers.ts  contract procedure -> use case calls
src/http/middleware.ts    origin/CORS/error classification
src/http/ws-terminal.ts   upgrade + ticket verification -> gateway handoff
src/http/tmux-hook.ts     hook endpoint handler
src/events.ts           SSE publisher
src/control/*.ts        unix-socket control handlers
```

Moves:
- `terminal-session.ts` (612) -> `infrastructure/src/terminal/session-gateway.ts`
  (NOTE: file imports @muximo/contract + spawnPty/PtyProcess/PreparedViewport/
  TmuxViewportManager/ViewportLease from @muximo/infrastructure — convert those
  to relative imports inside infra; verify infra package.json already depends on
  contract before moving)
  (+registry). Resume tokens stay inside the gateway (connection-level
  concern); device binding checks become injected callbacks if needed.
- `daemon.ts` (667→542) keeps process lifecycle only; health diagnostics moved to
  src/cli/health-diagnostics.ts and OpenCode registry cleanup to
  src/cli/opencode-registry.ts (re-exported through daemon for the runtime facade).

## Phase 3 — IN PROGRESS — CLI decomposition

Completed: pure helper tail extracted to `cli/host/command-support.ts`.
Remaining: split MuximoCommand methods into commands/<group>.ts with a declarative
parser, extract compose.ts (direct-db composition root) and presenters/.

Replace `cli/host/muximo-command.ts` (3662 lines, 62 functions) with:

```
entrypoint.ts      build program + parse
compose.ts         direct-db composition root (repos, audit, transaction manager)
commands/<group>.ts  declarative options + action=(deps)=>usecase call
presenters/        text rendering only (pairing QR etc.)
```

Candidate library: commander. Every command action may only call application
use cases (direct-db mode composes repositories through compose.ts).

## Verification per phase

```
bun run lint
node scripts/check-architecture.mjs
bun run test:local
per-package typecheck sweep
git commit (one commit per phase)
```

Known environment note: proxied sandboxes need NO_PROXY for localhost server
tests; `scripts/test-preload.ts` handles it via bunfig preload.
