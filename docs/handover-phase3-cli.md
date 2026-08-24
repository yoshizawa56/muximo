# Phase 3 CLI architecture handover

Phase 3 is complete. The CLI boundary is `createCliApp(deps)` in
`apps/muximo-cli/src/cli/app.ts`; all concrete construction, database initialization,
provider registration, adapters, resource ownership, and disposal are in
`apps/muximo-cli/src/cli/compose.ts`.

## Responsibility map

- `apps/muximo-cli/src/cli/commands/`: Commander command tree, Zod input schemas, and
  thin typed handlers.
- `apps/muximo-cli/src/cli/presenters/`: CLI output formatting only.
- `apps/muximo-cli/src/cli/adapters/`: pairing UI and control-socket transport only.
- `packages/application/src/usecases/agent-sessions/`: managed agent-session lifecycle
  policy and typed outcomes; `packages/application/src/usecases/daemon/` contains one
  focused lifecycle use case per daemon operation; `packages/application/src/usecases/shell/`
  owns shell workflow policy.
- `packages/application/src/ports/agent-sessions.ts`, `daemon.ts`, and `shell.ts`:
  focused asynchronous capability ports with provider-neutral business vocabulary.
- `packages/infrastructure/src/cli/`: concrete filesystem, Git, tmux, hook, serve, dev,
  shell, workspace, and diagnostic adapters. The shared daemon process adapter lives in
  `packages/infrastructure/src/process/daemon.ts` because both app entrypoints use it.

The old host/runtime directories, engine/lifecycle façade classes, broad session host
port, manual argv dispatch, and app-to-app muximod dependency are absent. Provider
implementation metadata is persisted by infrastructure-owned provider state; the domain
`AgentSession` retains only the `AgentBackend` capability union and provider-neutral
session identity. Launch plans dispose sidecars exactly once in success, failure, signal,
and cleanup paths. Resume claims pass the application-owned `updatedAt` value through
`ClaimExecutionInput`.

Daemon lifecycle timing is supplied through required application clock and scheduler ports.
Daemon results contain typed state and process outcomes; CLI presenters map them to text and
exit status. Serve adapters return structured URLs and subprocess observations, while the
CLI presenter owns the user-facing serve sentence. `apps/muximod` is a private server
entrypoint without a public CLI; daemon parsing remains in `apps/muximo-cli`.

Serve and dev composition computes deterministic exact browser origins, passes them to
daemon options and `MUXIMOD_ALLOWED_ORIGINS`, and rejects `*`. Local CLI calls without
an Origin remain supported separately by muximod.

## Verification contract

Run the following from the repository root:

```bash
node scripts/check-architecture.mjs
node scripts/check-table-tests.mjs
git diff --check
```

Then run focused CLI/application/infrastructure tests and the package typechecks. The
full local suite may include concurrent auth, HTTP, and UI work; report unrelated
failures without changing those files.
