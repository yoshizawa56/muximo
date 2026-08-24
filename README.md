# Muximo

Muximo is a mobile control room for tmux-hosted agents and shells. It lets you inspect and operate work on a development host from an iPhone or browser while the real processes remain in tmux.

> **Pre-alpha:** Muximo is still under active development. Configuration, APIs, and data formats may change.

[![CI](https://github.com/yoshizawa56/muximo/actions/workflows/ci.yml/badge.svg)](https://github.com/yoshizawa56/muximo/actions/workflows/ci.yml)

## What Muximo provides

- Browse registered host workspaces, tmux sessions, and panes from a mobile-sized UI.
- Open one pane at a time as an interactive terminal with input, resize, scrolling, and selection.
- Start and resume Codex, Claude Code, and OpenCode sessions, or create ordinary shell panes.
- Track agent states such as running, waiting for input, waiting for approval, completed, and failed.
- Create managed Git worktrees for agent sessions and keep their lifecycle state in SQLite.
- Use the same host-side `muximo` CLI and `muximod` daemon for desktop and mobile workflows.

## How it works

```text
iPhone / browser
  React + TypeScript + xterm.js
          |
          | HTTPS / WSS, normally through Tailscale Serve
          v
      muximod
  Bun host-side daemon
    | HTTP API and events
    | PTY-backed terminal WebSocket
    | SQLite and agent plugins
          |
          v
  tmux sessions and panes
  agents and shells
```

`muximod` runs next to tmux on the development host. HTTP is used for workspaces, sessions, panes, and state; WebSockets carry terminal data and small invalidation events. tmux remains the owner of the real pane and process. When a mobile terminal is connected, Muximo temporarily manages the shared viewport and restores desktop ownership when desktop activity is detected.

The web client does not contain a fixed host endpoint. `muximo pair` creates a short-lived QR pairing code, the client generates its device key locally, and the host explicitly approves the connection. Later HTTP requests use a short-lived authenticated session and terminal/event WebSockets use one-use tickets.

## Install

Install the latest stable release without requiring Bun or Node.js:

```sh
curl -fsSL https://github.com/yoshizawa56/muximo/releases/latest/download/install.sh | sh
muximo --help
```

The shell installer detects the current OS and architecture, downloads the matching release asset, verifies `SHA256SUMS.txt`, and installs the binary under `~/.local/libexec/muximo` with a command link under `~/.local/bin`. It requires `curl` or `wget` and one of `sha256sum`, `shasum`, or `openssl`. Override the install paths with `MUXIMO_INSTALL_DIR` and `MUXIMO_BIN_DIR` when needed.

Install a specific release by setting `MUXIMO_RELEASE_TAG`:

```sh
MUXIMO_RELEASE_TAG=v0.1.0 sh -c "$(curl -fsSL https://github.com/yoshizawa56/muximo/releases/download/v0.1.0/install.sh)"
```

Users who manage command-line tools with `mise` can install the same GitHub Release assets directly:

```sh
mise use -g github:yoshizawa56/muximo
muximo --help
```

For a checkout-based installation, use the Bun installer:

```sh
bun run muximo:install
muximo --help
```

The Bun installer also verifies the release checksum and supports `--tag`, `--from-build`, `MUXIMO_RELEASE_TAG`, `MUXIMO_INSTALL_DIR`, and `MUXIMO_BIN_DIR`. See `muximo --help` for the complete command and option list.

## Start the host daemon

The standalone command manages the long-running `muximod` process:

```sh
muximo daemon start
muximo daemon status
muximo daemon restart
muximo daemon stop
```

Use `muximo daemon start --foreground` when a service manager owns the process. `muximod` should remain bound to loopback and be exposed through a trusted HTTPS route such as Tailscale Serve.

Starting `muximod` does not create a tmux session. Create a new managed session with `muximo tmux new-session`, adopt an existing session with `muximo tmux manage-session --name <name>`, or let the Web connection flow adopt an unmanaged session automatically.

To configure a muximod-only Tailscale Serve route:

```sh
muximo serve tailscale
```

## Pair a device

The default pairing flow starts or verifies the host route, displays a QR code, and waits for explicit host approval:

```sh
muximo pair
```

Scan the QR code inside the Muximo Web or iOS client. The QR code is an in-app pairing code, not a browser navigation URL. For a local endpoint or an explicitly supplied route:

```sh
muximo pair --without-serve
muximo pair --muximod-base-url https://workstation.tailnet.ts.net:8449
```

## Common commands

Start and manage agent sessions on the host:

```sh
muximo run codex --worktree review
muximo run claude --no-worktree -n quick-fix
muximo run opencode --worktree experiment
muximo resume review
muximo list --json
muximo cleanup review
```

Manage workspaces and tmux sessions:

```sh
muximo workspace list
muximo workspace add ~/work/project --name project
muximo workspace update project --setup-hook ~/.config/muximo/setup
muximo workspace delete project
muximo tmux new-session -s project -c ~/work/project
muximo doctor --verbose
```

The Web UI can also create shell or agent panes, choose a new tmux window or split, and select a workspace or managed worktree. Use `muximo --help` for commands and options not shown here.

## Development

The repository uses `mise` for Bun, Node.js, and tmux versions:

```sh
mise install
bun install --frozen-lockfile
bun run dev
```

`bun run dev` starts an isolated muximod and Web profile for the current linked worktree while continuing to use the normal user tmux server. To inspect the Web UI without a running muximod:

```sh
VITE_MUXIMOD_MOCK_MODE=true bun run --filter @muximo/web dev
```

Useful repository checks are:

```sh
bun run typecheck
bun run test
bun run build
```

The iOS shell workflow is documented in [docs/mobile-capacitor.md](docs/mobile-capacitor.md). Worktree setup and cleanup examples are documented in [examples/hooks](examples/hooks/README.md).

## Security status

Muximo is pre-alpha software with host-level capabilities. A connected client can read and control the host user's tmux sessions and processes, and agent plugins run with the privileges of the `muximod` process. Do not expose muximod directly to the public internet or use it with untrusted tailnet users.

For the vulnerability reporting path and the current deployment boundary, see [SECURITY.md](SECURITY.md).

## Project files

- [LICENSE](LICENSE): MIT License
- [SECURITY.md](SECURITY.md): vulnerability reporting and deployment warnings
- [docs/mobile-capacitor.md](docs/mobile-capacitor.md): iOS development and release workflow
- [examples/hooks](examples/hooks/README.md): reusable worktree hook examples
