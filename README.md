# Muximo

Muximo is a mobile control room for tmux-hosted agents and shells. It lets you inspect and operate work on a development host from an iPhone or browser while the real processes remain in tmux.

> **Alpha:** Muximo is still under active development. Configuration, APIs, and data formats may change without compatibility guarantees.

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
muximo daemon log
muximo daemon restart
muximo daemon stop
```

`muximo daemon log` prints the most recent 100 lines from the daemon's derived
state log. Use `--lines N` to change the limit. Select a named profile with
`--env <name>`; each profile has its own derived state directory, ports, database,
PID file, socket, and log.

Use `muximo daemon start --foreground` when a service manager owns the process. `muximod` remains bound to loopback and is exposed through a trusted HTTPS route such as Tailscale Serve.

Starting `muximod` does not create a tmux session. Create a new managed session with `muximo tmux new-session`, adopt an existing session with `muximo tmux manage-session --name <name>`, or let the Web connection flow adopt an unmanaged session automatically.

To configure a muximod-only Tailscale Serve route:

```sh
muximo serve tailscale
```

The command discovers the current Tailscale hostname, configures the fixed
environment route, and records its public URL in the environment state. It
does not start or supervise `muximod`.

## Pair a device

After configuring the muximod Serve route, pairing displays a QR code and waits for explicit host approval:

```sh
muximo pair
```

Scan the QR code inside the Muximo Web or iOS client. The QR code is an in-app pairing code, not a browser navigation URL. For a local endpoint or an explicitly supplied route:

```sh
muximo pair --without-serve  # use the fixed loopback endpoint
muximo pair --muximod-base-url https://workstation.tailnet.ts.net:8444
```

## Common commands

Start and manage agent sessions on the host:

```sh
muximo run codex --worktree review
muximo run claude --no-worktree -n quick-fix
muximo run opencode --worktree experiment
muximo session resume review
muximo session list --json
muximo session cleanup review
```

The top-level `muximo list`, `muximo ls`, `muximo resume`, and `muximo cleanup` commands are aliases for the corresponding `session` commands.

Manage workspaces and tmux sessions:

```sh
muximo workspace list
muximo workspace add ~/work/project --name project --copy-pattern .env
muximo workspace update project --setup-hook ~/.config/muximo/setup
muximo workspace delete project
muximo tmux new-session -s project -c ~/work/project
muximo doctor --verbose
```

The selected environment is shared by all worktrees on the host. Generate an
ignored profile with the interactive setup command:

```sh
mise profile
```

The command asks for an arbitrary profile name, a tracked `.env.<name>.example`
recipe, client runtime (`browser`, `capacitor`, or `none`), connection details,
schema mode, and optional iOS Local configuration. A browser client requires a
Web runtime in the recipe. A bundled Capacitor client can use a recipe without
Web settings because muximod always allows its fixed `capacitor://localhost`
origin; a Capacitor Local client uses the generated HTTP(S) Web origin instead.
Each run regenerates the selected `.env.<name>` file from the recipe and
overwrites the generated iOS configuration when requested. The tracked
`.env.local.example` and `.env.stg.example` files are recommended recipes, not
fixed environment names. No worktree-local database, snapshot, or port
allocation is created.

The Web UI can also create shell or agent panes, choose a new tmux window or split, and select a workspace or managed worktree. Use `muximo --help` for commands and options not shown here.

## Development

The repository uses `mise` for Bun, Node.js, and tmux versions:

```sh
mise install
bun install --frozen-lockfile

# Generate or overwrite the ignored local profile and optional iOS settings.
mise profile

# Start the local muximod and Web processes independently.
mise muximo --env local daemon restart
mise web --env local daemon restart
mise muximo --env local serve tailscale
mise web --env local serve tailscale
```

The Web process uses one fixed local port and keeps HMR available after `web
daemon start`; the two processes have independent lifecycle commands. To inspect
the Web UI without a running muximod:

```sh
cd apps/web
VITE_MUXIMOD_MOCK_MODE=true bun node_modules/vite/bin/vite.js
```

For the Capacitor iOS workflow, use `mise ios` to build, sync, and open the native project. To run the local CLI through the repository's toolchain, use `mise muximo <option>`, for example `mise muximo --help`.

Useful repository checks are:

```sh
bun run verify
bun run typecheck
bun run test
bun run build
```

`bun run verify` runs the public-repository audit, lint, typecheck, tests, and
build together.

`bun run verify` is the complete repository check used by the pre-push hook and
CI. It runs the public-repository audit, lint, typecheck, tests, and build.
Use `bun run lint:fix` or `bun run format` when a check reports a fixable issue.
The pre-commit hook applies Biome fixes to staged JavaScript and TypeScript files
and then runs the repository typecheck.

The iOS shell workflow is documented in [docs/mobile-capacitor.md](docs/mobile-capacitor.md). Worktree setup and cleanup examples are documented in [examples/hooks](examples/hooks/README.md).

## Security status

Muximo is pre-alpha software with host-level capabilities. A connected client can read and control the host user's tmux sessions and processes, and agent plugins run with the privileges of the `muximod` process. Do not expose muximod directly to the public internet or use it with untrusted tailnet users.

For the vulnerability reporting path and the current deployment boundary, see [SECURITY.md](SECURITY.md).

## Project files

- [LICENSE](LICENSE): MIT License
- [SECURITY.md](SECURITY.md): vulnerability reporting and deployment warnings
- [docs/mobile-capacitor.md](docs/mobile-capacitor.md): iOS development and release workflow
- [examples/hooks](examples/hooks/README.md): reusable worktree hook examples
