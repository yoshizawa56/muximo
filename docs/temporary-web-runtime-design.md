# Temporary Web and Environment Runtime Design

Status: implementation working agreement.

This document freezes the runtime topology for the environment-profile and
Web lifecycle change. It is intentionally temporary: the accepted decisions
must be moved into the permanent architecture documents after implementation
and verification.

## Non-negotiable boundaries

- `packages/muximod` is the only owner of muximod composition, persistence,
  schema synchronization, database access, daemon resources, and daemon
  cleanup.
- `apps/muximo-cli` is a muximod client and host-side lifecycle entrypoint. It
  never opens SQLite, constructs a repository, synchronizes a schema, copies a
  database, or reads daemon-owned state or log files directly.
- `apps/web` is independent from `apps/muximo-cli`. Its browser code and its
  host-side lifecycle CLI must not start, stop, configure, or inspect muximod.
- `muximo-cli` must not start, stop, configure, or inspect the Web process.
- The two applications may share the generic `@muximo/profile` profile
  loader and the concrete Tailscale host adapter. Application entrypoints alone
  read `process.env` and pass the selected profile input to the loader. The
  loader may read `.env.<environment>` files, but it must not interpret
  component-specific variables. The applications must not share
  application-specific orchestration or call each other's entrypoints.
- Public URLs are not muximod runtime configuration. A client discovers and
  persists a URL for its own external route, then supplies the URL to a
  pairing request when needed.

## Environment profiles

The source/development entrypoints expose a global `--env <name>` option that
selects an arbitrary profile for the relevant client application. Each source
entrypoint parses the option, reads the ambient `process.env`, and resolves the
source repository root from its own module location; the shared
`@muximo/profile` package then loads `.env.<name>` from that root and returns
raw values. It does not interpret component-specific variables. Without
`--env`, no profile file is loaded.

The standalone production CLI is built from a production entrypoint with the
unnamed default profile. It does not expose `--env`, does not treat
`MUXIMO_ENV` as a profile selector, and does not load source repository profile
files. Development-only options and commands are filtered from its Commander
surface and shell completion.

Profile resolution is:

1. the application entrypoint supplies the source repository root, selected name,
   and ambient process environment to the generic loader;
2. if a name is selected, `.env.<name>` is parsed from the source repository
   root and overlays the ambient values;
3. the selected name is reflected in the raw environment as `MUXIMO_ENV`;
4. each application interprets only the values relevant to its own runtime;
5. each application applies its own name-independent defaults.

The supported Bun entrypoints use `bun --no-env-file` so Bun's automatic
`.env` discovery cannot bypass the explicit profile selection. Compiled CLI
invocations do not have Bun's automatic loading behavior.

There is no implicit `.env` fallback, worktree-derived environment, or
worktree-derived instance directory. A missing required profile file fails
with an actionable error.

The profile contains only stable environment configuration. Run `mise profile`
to select a tracked `.env.<name>.example` recipe and generate the ignored
`.env.<name>` file. The command can discover the Tailscale hostname and writes
machine-specific values only to the generated file. Rerunning it completely
replaces the selected profile; there are no incremental profile updates.

The raw profile may contain values for either application, including:

- environment name;
- muximod local port and external Serve port;
- Web local port and external Serve port;
- muximod schema mode (`migrate` by default, or explicit `push`);
- provider selection and provider-specific settings that are not discoverable.

The profile generator also asks whether the selected client is `browser`,
`capacitor`, or `none`. This is setup-time intent rather than a daemon setting:
the generated profile contains Web values only when the selected recipe and
client represent a Web runtime.
The bundled Capacitor shell uses the fixed `capacitor://localhost` origin,
which muximod allows automatically. `MUXIMOD_ALLOWED_ORIGINS` contains only
configurable HTTP(S) origins, such as the origin of a browser or a Capacitor
Local build that loads the Web runtime remotely. A recipe without Web values,
such as `.env.stg.example`, is therefore suitable for a bundled Capacitor
client without a Web daemon.

`@muximo/profile` exposes `getProfile()` for raw loading. `apps/muximo-cli`
and `apps/web` then resolve their own typed options independently. They do not
share component defaults or derived paths. An unused variable is simply ignored
by the application that does not need it.

The preferred state layout is derived from the selected profile and cannot be
overridden independently for individual PID, socket, database, or log files.
The unnamed default profile uses the state root directly; named profiles add
their name as one path segment:

The default state root is `~/.local/state/muximo`; `MUXIMO_STATE_ROOT` may
replace that root as one deliberate global override. The derived layout is:

```text
<state-root>/muximod/
  muximod.sqlite
  muximod.pid
  muximod.sock
  muximod.log
  serve.json

<state-root>/<profile>/muximod/
  muximod.sqlite
  muximod.pid
  muximod.sock
  muximod.log
  serve.json

<state-root>/web/
  web.pid
  web.log
  serve.json

<state-root>/<profile>/web/
  web.pid
  web.log
  serve.json
```

All worktrees selecting the same profile use the same component state. Starting
from another worktree therefore does not create another database or daemon. A
deliberate `daemon restart` replaces the active process with the code from the
selected worktree.

## Muximod lifecycle

The muximod application remains responsible for its own runtime and database.
The CLI invokes the typed lifecycle API exposed by `@muximo/muximod/client`.

The source/development CLI supports these conceptual commands:

```text
muximo --env <name> daemon start
muximo --env <name> daemon restart
muximo --env <name> daemon stop
muximo --env <name> daemon status
muximo --env <name> serve tailscale
muximo --env <name> serve status
muximo --env <name> serve stop
```

`daemon start` starts or reuses the one healthy muximod for the selected
profile. `daemon restart` explicitly replaces the known process and runs the
selected schema mode inside muximod. Every profile uses `migrate` by default;
setting `MUXIMO_SCHEMA_MODE=push` in the selected profile explicitly opts into
push. No base instance directory and no snapshot copy are used.

The muximod `serve` command manages only the muximod external route. It does
not start or stop Web and does not become a long-running supervisor.

## Web lifecycle

`apps/web` receives a lightweight host-side CLI entrypoint in addition to its
browser bundle. The CLI has no muximod dependency and manages only the Web
process and the Web external route.

Conceptual commands are:

```text
web --env <name> daemon start
web --env <name> daemon restart
web --env <name> daemon stop
web --env <name> daemon status
web --env <name> serve tailscale
web --env <name> serve status
web --env <name> serve stop
```

The Web daemon and Web Serve commands are intentionally independent:

- `web daemon start` starts the selected Web runtime on the fixed local port
  and ensures one process per environment.
- `web daemon restart` replaces only the known Web process.
- `web daemon stop` stops only the Web process and leaves the external route
  configured.
- `web serve tailscale` checks that the Web target is usable, configures the
  fixed external route, discovers the provider hostname, and records the
  resulting public URL. It does not spawn Web.
- `web serve stop` removes only the matching Web route and leaves Web running.

The Web host CLI may use a PID record, an atomic environment lock, a process
fingerprint, and a local health probe. It may clean up only a process that its
own environment state identifies. An unrelated process occupying the fixed
local port produces a clear conflict instead of an unbounded port change.

The Web entrypoint must remain outside the browser bundle. Vite code must not
import Node.js process-management or Tailscale code.

## Tailscale provider boundary

The shared Tailscale adapter lives under
`packages/infrastructure/src/tailscale`. It owns only provider mechanics:

- resolve the current Tailscale hostname;
- apply a route from a loopback target to a fixed external port and path;
- inspect the live route configuration;
- remove a route using the exact route identity/configuration;
- return structured command output and provider errors.

The adapter does not know whether the target is Web or muximod, does not read
profile files, does not manage PID files, and does not write component state.
Each application composes the adapter independently and writes its own
`serve.json` atomically.

The route state includes at least:

```text
environment
provider
hostname
publicUrl
localTarget
externalPort
path
routeFingerprint
updatedAt
```

The state file is a client-owned provider hint, not daemon state and not the
sole authority. `serve status` and pairing flows verify the live provider
configuration and target health before returning or using a URL. Cleanup must
compare the stored route identity so an old invocation cannot remove a newer
route.

Local fixed route defaults remain stable. The current local topology is:

```text
Web:     http://127.0.0.1:5227 -> https://<hostname>:8449/
muximod: http://127.0.0.1:4317 -> https://<hostname>:8444/
```

For source/development runs, named profile values come from the selected profile;
the unnamed default profile uses built-in defaults. The standalone production CLI
uses those built-in defaults and does not select a source profile. External ports
must not overlap when multiple profiles share a Tailscale node.

With Tailscale Serve background mode, the route is persistent after the
command exits. The CLI command therefore configures or verifies a route and
returns; it is not a foreground process supervisor.

## Public URL consumers

`muximo pair` obtains the muximod public URL from muximod's client-owned
`serve.json`, verifies the live route, and sends that URL through the private
control contract at pairing time. The URL is not stored in muximod launch
configuration and muximod does not need to know how it was discovered.
`muximo pair --without-serve` is the explicit local-only exception: it uses
the selected environment's fixed loopback URL, verifies that endpoint, and
does not read or change Serve state.

The Web public URL is consumed only by the local iOS build. The Web CLI does
not know about iOS. The existing ignored `apps/web/ios/local.xcconfig` remains
the build-time injection point. `mise profile` can generate that file from the
selected connection details when a Capacitor Local client is selected, which
keeps hostname discovery automatic while preserving the Web/iOS build
boundary. Bundled Capacitor builds do not need a Web public URL. The committed
example contains placeholders only.

Because a local Tailscale hostname is machine-specific, an ignored local iOS
configuration is an intentional per-person setting. It must not be embedded
in the shared source profile unless all users intentionally share the same
hostname.

## Removal of the old development topology

The following are removed from the canonical runtime path:

- `apps/serve`;
- `@muximo/portless-support` and `portless.json`;
- `apps/muximo-cli/dev.ts` and the public `muximo dev` command;
- worktree IDs and worktree-specific muximod instance directories;
- `baseInstanceDir`, snapshot copying, and development seeding behavior;
- dynamic Portless URLs and `PORTLESS_URL` configuration.

Vite keeps `strictPort: true`, so a fixed-port conflict fails visibly instead
of silently selecting a different URL. HMR remains a property of the Web
runtime started by `web daemon start`; it does not require a repository-wide
supervisor.

An optional shell or `mise` task may start the independent muximod and Web
commands for convenience, but no application package owns a combined
supervisor. Failure of Web therefore does not stop muximod, and failure of
muximod does not stop Web; that independence is intentional.

## Implementation checklist

- [x] Add common raw profile loading and app-owned `--env` interpretation to both client entrypoints.
- [x] Make environment state paths deterministic and component-specific.
- [x] Remove snapshot/base-directory handling from muximod launch options.
- [x] Keep schema synchronization inside muximod and remove all CLI database paths.
- [x] Add Web daemon process management with one instance per environment.
- [x] Split Web Serve management from Web daemon management.
- [x] Refactor muximod Serve to be route-only and state-backed.
- [x] Reuse the shared Tailscale adapter without sharing app orchestration.
- [x] Remove `apps/serve`, Portless, and the public development supervisor.
- [x] Preserve fixed local Web and muximod URLs.
- [x] Keep iOS Web URL injection in ignored local build configuration.
- [x] Add table-driven tests for profile resolution, route state, cleanup
  identity, and the removed topology; retain lifecycle coverage for daemon
  ownership and replacement.
- [x] Update permanent architecture documents after verification.
