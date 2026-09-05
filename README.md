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

Production releases contain one `muximo` binary. The daemon is an internal
process mode started and managed by that binary; `muximod` is not a separate
user-facing executable.

`muximo daemon log` prints the most recent 100 lines from the daemon's instance
log. Use `--lines N` to change the limit. The default instance directory is
`~/.local/state/muximo`; select another one with `--instance-dir <path>` or
`MUXIMOD_INSTANCE_DIR`.

The daemon is started and managed by the local `muximo` command. `muximod` remains bound to loopback and is exposed through a trusted HTTPS route such as Tailscale Serve.

## Instance configuration

Host-wide settings are stored in `config.json` inside the selected muximod
instance directory (`~/.local/state/muximo/config.json` by default). Select the
directory with `--instance-dir <path>` or `MUXIMOD_INSTANCE_DIR`. `muximo config`
is the intentional local file-management exception; the daemon reads and
validates the file during startup, and normal CLI commands obtain daemon-owned
values through the daemon API or private control socket.

Create or inspect it with:

```sh
muximo config init
muximo config path
muximo config show
```

The interactive editor uses the `@inquirer/prompts` keyboard interface. It
first asks which agent backends to enable; selecting none keeps the instance in
tmux-only mode. Detected executables are offered as choices, while executable
and workspace paths can be entered with filesystem completion. Tailscale and
other settings are presented as high-level recommended/custom choices, and
individual fields are asked only when selected. Every value is validated as
soon as it is entered, with the error shown before the same field is retried. The
non-interactive form is useful for scripts:

```sh
muximo config set workspace.roots ~/work/project,~/work/other
muximo config set agents.enabled codex,claude
muximo config set agents.default claude
muximo config set agents.executables.claude ~/.local/bin/claude
muximo config set serve.tailscale.enabled true
muximo config set serve.tailscale.executable /usr/local/bin/tailscale
muximo config set serve.tailscale.args '["--socket", "/run/user/1000/tailscaled.sock"]'
```

Run `muximo config set --help` for the complete key catalog, accepted value
formats, choices, and examples. The generated zsh completion uses the same
catalog for configuration keys and key-specific values. On macOS, the default
Tailscale executable is `/Applications/Tailscale.app/Contents/MacOS/Tailscale`,
which is the bundled CLI path for the App Store application. If the standalone
CLI integration is installed instead, configure `/usr/local/bin/tailscale` or
the appropriate executable path explicitly. Successful `config init` and
`config set` commands report changed values as `before -> after`; use `config
path` or `config show` when the file itself is needed. Configuration changes are
applied after `muximo daemon restart`.

The default configuration enables no agent backends. Disabled providers are
not registered by the daemon, so an uninstalled tool such as OpenCode cannot
prevent daemon startup. A provider executable is resolved only when a session
using that provider is launched. After changing agent settings, run
`muximo daemon restart` before starting new sessions.

Executable settings accept a program name or path. Tailscale arguments are
stored separately as an argv prefix. Neither setting evaluates shell aliases or
shell command strings; use a wrapper executable when a per-user command needs
custom setup. Configuration files are written atomically with user-only
permissions.

Starting `muximod` does not create a tmux session. Create a new managed session with `muximo tmux new-session`, adopt an existing session with `muximo tmux manage-session --name <name>`, or let the Web connection flow adopt an unmanaged session automatically.

To configure a muximod-only Tailscale Serve route:

```sh
muximo config set serve.tailscale.enabled true
muximo serve tailscale
```

The command discovers the current Tailscale hostname, configures the fixed
instance route, and records its public URL in the instance state. It
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
muximo config set agents.enabled codex,claude,opencode
muximo run opencode --worktree experiment
muximo session resume review
muximo session list --json
muximo session cleanup review
```

The top-level `muximo list`, `muximo ls`, `muximo resume`, and `muximo cleanup` commands are aliases for the corresponding `session` commands.

Manage workspaces and tmux sessions:

```sh
muximo workspace list
muximo workspace add ~/work/project --name project
muximo workspace update project --setup-hook ~/.config/muximo/setup
muximo workspace delete project
muximo tmux new-session -s project -c ~/work/project
muximo doctor --verbose
```

OpenCode server connections are shared within one Muximo instance. Muximo
reuses a healthy server and starts one only when no connection is available;
stopping or restarting `muximod` does not stop it. To use an OpenCode server
started outside Muximo, configure its local URL before running the session:

```sh
muximo config set agents.opencode.serverUrl http://127.0.0.1:4096
muximo daemon restart
muximo run opencode
```

The Web UI can also create shell or agent panes, choose a new tmux window or split, and select a workspace or managed worktree. Use `muximo --help` for commands and options not shown here.

## Development

The repository uses `mise` for Bun, Node.js, and tmux versions:

```sh
mise install
bun install --frozen-lockfile

# Configure the local muximo instance and start its daemon.
mise muximo config init
mise muximo daemon restart

# Start the independent Web development process when needed.
mise web daemon restart
mise muximo serve tailscale
mise web serve tailscale
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
