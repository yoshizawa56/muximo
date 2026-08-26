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

workspace_path() {
  case "$1" in
    /*) printf '%s\n' "$1" ;;
    *) printf '%s/%s\n' "$MUXIMO_WORKSPACE" "$1" ;;
  esac
}

env_file=${MUXIMO_ENV_FILE:-.env}
env_file=$(worktree_path "$env_file")
instance_path=${MUXIMO_INSTANCE_PATH:-.local}
instance_directory=$(worktree_path "$instance_path")
database_path=${MUXIMO_DB_PATH:-$instance_path/muximod.sqlite}
database_file=$(worktree_path "$database_path")
mkdir -p "$instance_directory"
chmod 700 "$instance_directory"
mkdir -p "$(dirname -- "$database_file")"

home_directory=${HOME:-}
default_instance_directory=${MUXIMOD_INSTANCE_DIR:-$home_directory/.local/state/muximo}
default_database_file=$default_instance_directory/muximod.sqlite
base_database_file=${MUXIMO_BASE_DB_FILE:-$default_database_file}
case "$base_database_file" in
  ~) base_database_file=$home_directory ;;
  ~/*) base_database_file=$home_directory/${base_database_file#~/} ;;
  /*) ;;
  *) base_database_file=$(workspace_path "$base_database_file") ;;
esac

if [ "${MUXIMO_COPY_DB:-1}" = "1" ]; then
  if [ -f "$base_database_file" ]; then
    if [ -e "$database_file" ] && [ "${MUXIMO_DB_COPY_FORCE:-0}" != "1" ]; then
      hook_log "SQLite target already exists; keeping $database_file"
    else
      if [ "${MUXIMO_DB_COPY_FORCE:-0}" = "1" ]; then
        cp -fp "$base_database_file" "$database_file"
      else
        cp -p "$base_database_file" "$database_file"
      fi
      hook_log "copied SQLite seed to $database_file"
    fi
  elif [ "${MUXIMO_REQUIRE_BASE_DB:-0}" = "1" ]; then
    hook_die "base SQLite database does not exist: $base_database_file"
  else
    hook_log "base SQLite database not found; a new database will be created: $base_database_file"
  fi
else
  hook_log "SQLite copy disabled; using the worktree database path"
fi
if [ -e "$database_file" ]; then
  chmod 600 "$database_file"
fi

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
  --port VITE_DEV_PORT=5227 \
  --set "MUXIMOD_INSTANCE_DIR=$instance_directory"

if [ "${MUXIMO_INSTALL_DEPENDENCIES:-0}" = "1" ]; then
  command -v bun >/dev/null 2>&1 || hook_die "MUXIMO_INSTALL_DEPENDENCIES=1 requires bun"
  hook_log "installing locked dependencies in the worktree"
  (cd "$MUXIMO_WORKTREE" && bun install --frozen-lockfile)
fi

if [ -n "${MUXIMO_MIGRATION_COMMAND:-}" ]; then
  hook_log "running configured SQLite migration"
  MUXIMOD_INSTANCE_DIR="$instance_directory" \
    sh -c "$MUXIMO_MIGRATION_COMMAND"
else
  hook_log "SQLite migration skipped; set MUXIMO_MIGRATION_COMMAND to enable one"
fi

hook_log "worktree environment is ready: $env_file"
