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
- The two applications may share the pure `@muximo/environment` value normalizer
  and the concrete Tailscale host adapter. The application entrypoints alone read
  `process.env` and `.env.<environment>` files. They must not share
  application-specific orchestration or call each other's entrypoints.
- Public URLs are not muximod runtime configuration. A client discovers and
  persists a URL for its own external route, then supplies the URL to a
  pairing request when needed.

## Environment profiles

The global `--env` option selects one of `local`, `stg`, or `prod` for both
client applications. Profile selection is performed by each application
entrypoint. The shared `@muximo/environment` package only normalizes explicitly
supplied values; it has no `process.env` access and does not read profile files.

Profile resolution is:

1. the process environment supplies machine-local values and supported global
   overrides;
2. the selected profile file for source checkouts (`.env.local` or `.env.stg`)
   owns profile-scoped values such as ports and schema mode;
3. built-in production defaults are used for `prod`;
4. the explicit `--env` argument selects the profile and is reflected in the
   resolved environment.

There is no implicit `.env` fallback, worktree-derived environment, or
worktree-derived instance directory. A missing required profile file fails
with an actionable error.

The profile contains only stable environment configuration. It does not need
the Tailscale hostname when the provider can discover the current hostname.
The local and staging profile examples may be committed; machine-specific
files and personal hostnames remain ignored.

The profile defines the component values needed by each independent
application, including:

- environment name;
- muximod instance directory or environment state root;
- muximod local port and external Serve port;
- Web local port and external Serve port;
- muximod schema mode (`push` for `local`, `migrate` for `stg` and `prod`);
- Web runtime mode and whether the Web daemon is enabled for the profile;
- provider selection and provider-specific settings that are not discoverable.

The preferred state layout is derived from the selected environment and cannot
be overridden independently for individual PID, socket, database, or log
files:

The default state root is `~/.local/state/muximo`; `MUXIMO_STATE_ROOT` may
replace that root as one deliberate global override. The derived layout is:

```text
<state-root>/<environment>/muximod/
  muximod.sqlite
  muximod.pid
  muximod.sock
  muximod.log
  serve.json

<state-root>/<environment>/web/
  web.pid
  web.log
  serve.json
```

All worktrees selecting the same environment use the same component state.
Consequently, `local` is a singleton runtime: starting from another worktree
does not create another local database or daemon. A deliberate
`daemon restart` replaces the active process with the code from the selected
worktree.

## Muximod lifecycle

The muximod application remains responsible for its own runtime and database.
The CLI invokes the typed lifecycle API exposed by `@muximo/muximod/client`.

Conceptual commands are:

```text
muximo --env local daemon start
muximo --env local daemon restart
muximo --env local daemon stop
muximo --env local daemon status
muximo --env local serve tailscale
muximo --env local serve status
muximo --env local serve stop
```

`daemon start` starts or reuses the one healthy muximod for the selected
environment. `daemon restart` explicitly replaces the known process and runs
the selected schema mode inside muximod. `local` uses `push` against its
single persistent SQLite file; no base instance directory and no snapshot
copy are used. `stg` and `prod` use migrations against their own files.

The muximod `serve` command manages only the muximod external route. It does
not start or stop Web and does not become a long-running supervisor.

## Web lifecycle

`apps/web` receives a lightweight host-side CLI entrypoint in addition to its
browser bundle. The CLI has no muximod dependency and manages only the Web
process and the Web external route.

Conceptual commands are:

```text
web --env local daemon start
web --env local daemon restart
web --env local daemon stop
web --env local daemon status
web --env local serve tailscale
web --env local serve status
web --env local serve stop
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

The exact staging and production values come from their profiles. External
ports must not overlap when multiple environments share a Tailscale node.

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
the build-time injection point. A small iOS-side generation step may derive
that file from Web's `serve.json`; this keeps hostname discovery automatic
while preserving the Web/iOS build boundary. The committed example contains
placeholders only.

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

- [x] Add app-owned `--env` profile loading to both client entrypoints.
- [x] Make environment state paths deterministic and component-specific.
- [x] Remove snapshot/base-directory handling from muximod launch options.
- [x] Keep local schema push inside muximod and remove all CLI database paths.
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
