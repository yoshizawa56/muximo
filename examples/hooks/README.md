# Worktree hook examples

This directory contains setup and cleanup hook examples for `muximo run ... --worktree`.

## Structure

- `generic/`: repository-independent helpers
  - `allocate-ports.sh`: an optional deterministic allocator for repositories that need per-worktree ports
- `muximo/`: repository-specific setup and cleanup hook examples

The setup hook performs these steps:

1. Validate the host workspace and managed worktree paths.
2. Run `bun install --frozen-lockfile` when `MUXIMO_INSTALL_DEPENDENCIES=1`.

Muximo environment state is selected explicitly with `muximo --env local|stg|prod`.
All worktrees selecting the same profile use the same environment state, fixed
ports, and daemon. The hook does not create environment files, allocate ports,
copy databases, seed data, migrate schemas, or otherwise open a muximod database.

The cleanup hook has no environment or process state to release.

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

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `MUXIMO_INSTALL_DEPENDENCIES` | `0` | Install locked dependencies when set to `1` |

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
