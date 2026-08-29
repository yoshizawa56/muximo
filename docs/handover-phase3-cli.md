# Phase 3 CLI architecture handover

Phase 3 is complete. The CLI boundary is `createCliApp(deps)` in
`apps/muximo-cli/src/cli/app.ts`; CLI construction wires client contracts and host-only
adapters in `apps/muximo-cli/src/cli/compose.ts`. Database initialization, provider
registration, daemon-owned resource ownership, and daemon disposal remain inside
`packages/muximod`.

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
- `packages/infrastructure/src/cli/`: concrete filesystem, Git, tmux, hook, serve,
  shell, workspace, and diagnostic adapters. It must not read daemon-owned logs or state.
  Muximod process lifecycle, database composition, bootstrap, and resource
  cleanup live in `packages/muximod`.

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
CLI presenter owns the user-facing serve sentence. `apps/muximod` does not exist.
`packages/muximod` contains the private runtime bootstrap without a public CLI;
daemon parsing remains in `apps/muximo-cli`.

The CLI resolves the selected `--env <name>` profile, then uses the muximod API over local HTTP
for workspace and agent-session operations, minting a short-lived local API token through
the private control socket. Pairing, pane control, and daemon diagnostics use the typed
private control contract. The CLI never opens the daemon database or reads daemon-owned
files. Every profile defaults to migrations; `MUXIMO_SCHEMA_MODE=push` explicitly
selects push. There is no worktree snapshot or base-instance copy.

`apps/web/cli.ts` independently manages the Web process and its Tailscale route. It does
not import or invoke muximod. Muximod Serve is route-only, and there is no combined
development supervisor or Portless dependency.

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
