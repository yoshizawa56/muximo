# Worktree hook examples

This directory contains setup and cleanup hook examples for `muximo run ... --worktree`.

## Structure

- `generic/`: repository-independent helpers
  - `allocate-ports.sh`: deterministically assigns per-worktree ports from a workspace/name checksum
- `muximo/`: a repository-specific example that combines the allocator with the muximo workflow

SQLite seed copying and migration are kept directly in `muximo/setup.sh` because they depend on muximo's database paths and workflow. The base database is treated as a seed that is not updated concurrently and is copied as a single file with `cp` when present.

The setup hook performs these steps:

1. Copy an optional base SQLite database to `.local/muximod.sqlite` in the worktree.
2. Derive `MUXIMOD_PORT` and `VITE_DEV_PORT` from `MUXIMO_WORKSPACE` and `MUXIMO_NAME`, then save them to the worktree's `.env`.
3. Run `bun install --frozen-lockfile` when `MUXIMO_INSTALL_DEPENDENCIES=1`.
4. Run a SQLite migration only when `MUXIMO_MIGRATION_COMMAND` is set.

The cleanup hook does not release ports. Because ports are derived mechanically from the inputs, no registry cleanup is required when a managed worktree is removed. The database and `.env` remain inside the worktree and are removed with it.

## Using the hooks with muximo

Hooks are registered as executable files that live on the host; they are not copied into the worktree. Grant them execute permission first:

```sh
chmod +x examples/hooks/generic/allocate-ports.sh
chmod +x examples/hooks/muximo/*.sh
```

To use them directly from the CLI:

```sh
muximo run codex --worktree review \
  --setup-hook "$PWD/examples/hooks/muximo/setup.sh" \
  --cleanup-hook "$PWD/examples/hooks/muximo/cleanup.sh"
```

When creating a worktree from the Web UI, set `SETUP SCRIPT PATH` and `CLEANUP SCRIPT PATH` during workspace registration to host-side absolute paths such as:

```text
/path/to/muximo/examples/hooks/muximo/setup.sh
/path/to/muximo/examples/hooks/muximo/cleanup.sh
```

To use this repository's default SQLite database as the seed:

```sh
MUXIMO_BASE_DB_FILE="$HOME/.local/state/muximo/muximod.sqlite" \
MUXIMO_INSTALL_DEPENDENCIES=1 \
muximo run codex --worktree review
```

If the base database does not exist, copying is skipped and muximod creates a new database in the worktree. Add `MUXIMO_REQUIRE_BASE_DB=1` to require the source database. Use `MUXIMO_DB_COPY_FORCE=1` only when an existing worktree database should be explicitly overwritten.

Ports are derived from the combination of `MUXIMO_WORKSPACE` and `MUXIMO_NAME`. The CLI does not allow duplicate names within the same workspace, so ordinary worktrees receive different slots. If the name is generated automatically, recreating a worktree may result in a different port assignment.

Normal `muximo` and `muximod` startup apply the repository's Drizzle migrations automatically. The hook does not need to run a migration for the normal workflow. Use `MUXIMO_MIGRATION_COMMAND` only when an explicit administrative migration command is required:

```sh
MUXIMO_MIGRATION_COMMAND='bun run db:migrate' \
muximo run codex --worktree review
```

`MUXIMO_MIGRATION_COMMAND` is executed with `sh -c` as a trusted local setting. The worktree instance directory is provided through `MUXIMOD_INSTANCE_DIR`; muximod derives the database path from that directory.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `MUXIMO_BASE_DB_FILE` | `$MUXIMOD_INSTANCE_DIR/muximod.sqlite` (default `~/.local/state/muximo/muximod.sqlite`) | Source SQLite database |
| `MUXIMO_INSTANCE_PATH` | `.local` | Instance directory inside the worktree |
| `MUXIMO_DB_PATH` | `$MUXIMO_INSTANCE_PATH/muximod.sqlite` | Advanced database path override inside the worktree |
| `MUXIMO_ENV_FILE` | `.env` | Environment file for ports and the database path |
| `MUXIMO_PORT_STRIDE` | `3` | Port increment per checksum slot |
| `MUXIMO_PORT_SLOT_COUNT` | `20000` | Number of checksum slots |
| `MUXIMO_INSTALL_DEPENDENCIES` | `0` | Install locked dependencies when set to `1` |
| `MUXIMO_MIGRATION_COMMAND` | Not set | Run this migration command when configured |

The allocator does not maintain a port registry or check whether another process has already bound a port. External processes and checksum-slot collisions cannot be prevented completely. If `bun run dev` reports a strict-port error, change `MUXIMOD_PORT` or `VITE_DEV_PORT` manually in `.env`. Existing port values are preserved when setup runs again.

## Reusing the allocator in other repositories

Only the port allocator is intended as a reusable component for other worktree-enabled repositories:

```sh
examples/hooks/generic/allocate-ports.sh allocate \
  --key "$MUXIMO_WORKSPACE:$MUXIMO_NAME" \
  --env-path "$MUXIMO_WORKTREE/.env" \
  --stride 3 \
  --slot-count 20000 \
  --port API_PORT=4317 \
  --port WEB_PORT=5227
```

When allocating multiple services, the `NAME=BASE` values passed to `--port` must use different lanes modulo `--stride`. For example, `4317` and `5227` use different lanes with `--stride 3`. Keep composed setup hooks idempotent, never write secrets to repository hooks or generated logs, and manage hook paths as host-side configuration.
