#!/bin/sh
set -eu
umask 077

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
generic_directory=$script_directory/../generic

hook_log() {
  printf 'hook: %s\n' "$*"
}

hook_die() {
  printf 'hook: %s\n' "$*" >&2
  exit 1
}

if [ -z "${MUXIMO_WORKSPACE:-}" ] || [ ! -d "$MUXIMO_WORKSPACE" ]; then
  hook_die "MUXIMO_WORKSPACE must point to an existing directory"
fi
if [ -z "${MUXIMO_WORKTREE:-}" ] || [ ! -d "$MUXIMO_WORKTREE" ]; then
  hook_die "MUXIMO_WORKTREE must point to an existing directory"
fi

worktree_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$MUXIMO_WORKTREE" "$1" ;;
  esac
}

env_file=${MUXIMO_ENV_FILE:-.env}
env_file=$(worktree_path "$env_file")
mkdir -p "$(dirname -- "$env_file")"

port_stride=${MUXIMO_PORT_STRIDE:-3}
port_slot_count=${MUXIMO_PORT_SLOT_COUNT:-20000}
if [ -z "${MUXIMO_WORKSPACE:-}" ] || [ -z "${MUXIMO_NAME:-}" ]; then
  hook_die "MUXIMO_WORKSPACE and MUXIMO_NAME are required for deterministic port allocation"
fi

"$generic_directory/allocate-ports.sh" allocate \
  --key "$MUXIMO_WORKSPACE:$MUXIMO_NAME" \
  --env-path "$env_file" \
  --stride "$port_stride" \
  --slot-count "$port_slot_count" \
  --port MUXIMOD_PORT=4317 \
  --port VITE_DEV_PORT=5227

if [ "${MUXIMO_INSTALL_DEPENDENCIES:-0}" = "1" ]; then
  command -v bun >/dev/null 2>&1 || hook_die "MUXIMO_INSTALL_DEPENDENCIES=1 requires bun"
  hook_log "installing locked dependencies in the worktree"
  (cd "$MUXIMO_WORKTREE" && bun install --frozen-lockfile)
fi

hook_log "worktree environment is ready: $env_file"
