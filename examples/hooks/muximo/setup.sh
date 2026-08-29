#!/bin/sh
set -eu
umask 077

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

if [ "${MUXIMO_INSTALL_DEPENDENCIES:-0}" = "1" ]; then
  command -v bun >/dev/null 2>&1 || hook_die "MUXIMO_INSTALL_DEPENDENCIES=1 requires bun"
  hook_log "installing locked dependencies in the worktree"
  (cd "$MUXIMO_WORKTREE" && bun install --frozen-lockfile)
fi

hook_log "worktree dependencies are ready"
