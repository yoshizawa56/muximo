# Worktree hook examples

This directory contains setup and cleanup hook examples for `muximo run ... --worktree`.

## Structure

- `generic/`: repository-independent helpers
  - `allocate-ports.sh`: deterministically assigns per-worktree ports from a workspace/name checksum
- `muximo/`: a repository-specific example that combines the allocator with the muximo workflow

The setup hook performs these steps:

1. Derive `MUXIMOD_PORT` and `VITE_DEV_PORT` from `MUXIMO_WORKSPACE` and `MUXIMO_NAME`, then save them to the worktree's `.env`.
2. Run `bun install --frozen-lockfile` when `MUXIMO_INSTALL_DEPENDENCIES=1`.

The development CLI owns muximod state. In a linked Git worktree it selects a
worktree-specific instance directory and `packages/muximod` takes a complete
snapshot of the base SQLite database on first startup. The hook does not copy,
seed, migrate, or otherwise open a muximod database.

The cleanup hook does not release ports. Because ports are derived mechanically from the inputs, no registry cleanup is required when a managed worktree is removed. The `.env` remains inside the worktree and is removed with it.

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

Ports are derived from the combination of `MUXIMO_WORKSPACE` and `MUXIMO_NAME`. The CLI does not allow duplicate names within the same workspace, so ordinary worktrees receive different slots. If the name is generated automatically, recreating a worktree may result in a different port assignment.

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `MUXIMO_ENV_FILE` | `.env` | Environment file for development ports |
| `MUXIMO_PORT_STRIDE` | `3` | Port increment per checksum slot |
| `MUXIMO_PORT_SLOT_COUNT` | `20000` | Number of checksum slots |
| `MUXIMO_INSTALL_DEPENDENCIES` | `0` | Install locked dependencies when set to `1` |

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
