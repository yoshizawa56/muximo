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
- Tooling: Biome (lint=0 gate), lefthook pre-commit (Biome autofix + typecheck),
  pre-push and CI run the complete `bun run verify` check,
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

## Phase 3 — DONE — CLI decomposition

The CLI now has one explicit boundary, `createCliApp(deps)`, and one concrete
composition root, `apps/muximo-cli/src/cli/compose.ts`. Commander owns the complete
command tree, while each command module validates Commander values with Zod and calls
one typed handler. The entrypoint owns only argv, environment, streams, invocation,
error reporting, and exit status.

Application lifecycle policy is split into `RunAgentSession`, `ResumeAgentSession`,
`ListAgentSessions`, `CleanupAgentSession`, and `LocateAgentSession`. Their focused ports
are provider-neutral and asynchronous for filesystem, Git, process, and observation I/O.
Launch plans return typed session updates and own exactly-once disposal. Resume claims
receive an application-generated `ClaimExecutionInput.updatedAt`.

Concrete CLI capabilities live under `packages/infrastructure/src/cli/`: backend
launch/discovery, worktrees, hooks, panes, workspace, observations, shell, tmux sessions,
serve, dev, and diagnostics. The shared daemon process and timing adapters live under
`packages/infrastructure/src/process/`. Pairing UI and control-socket
transport remain CLI-local adapters. Browser origins are normalized and passed exactly
to daemon options/environment; wildcard origins are rejected.

The former host/runtime directories, engine/lifecycle façade classes, broad session host
port, manual parser paths, and CLI-to-muximod package dependency are removed. Provider
implementation metadata is persisted through infrastructure-owned state rather than domain
record mutation. Application results are typed business outcomes; CLI presenters own
messages and process status mapping. `apps/muximod` remains a private server entrypoint
without a public Commander/Zod CLI.

## Verification per phase

```
bun run verify
```

For focused local feedback, `bun run lint`, `node scripts/check-architecture.mjs`,
`bun run test:local`, and the per-package typecheck sweep remain available.

Known environment note: proxied sandboxes need NO_PROXY for localhost server
tests; `scripts/test-preload.ts` handles it via bunfig preload.
