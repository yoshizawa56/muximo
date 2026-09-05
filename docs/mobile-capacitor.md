# Capacitor mobile shell

The iOS shell lives under `apps/web/ios` and packages the existing Vite build. The Web UI remains the source of truth for screens, routing, HTTP, WebSocket, and xterm.js behavior. Capacitor provides the native lifecycle and packaging boundary.

## Local workflow

From the repository root:

```sh
bun install --frozen-lockfile
bun --cwd apps/web run cap:sync
bun --cwd apps/web run cap:open
```

The same sync-and-open sequence is available as `mise ios`. `cap:sync` already performs the Web build before syncing the native project.

`cap:sync` builds `apps/web/dist` and copies it into the iOS project. Run the Debug app from Xcode or use `cap:run` after the native project has been prepared.

The `Local` scheme loads a fixed Web URL from the ignored
`apps/web/ios/local.xcconfig`. Create it from the committed example and edit the
URL for the host running the Web process:

```sh
cp apps/web/ios/local.xcconfig.example apps/web/ios/local.xcconfig
```

Set `MUXIMO_WEB_SCHEME`, `MUXIMO_WEB_HOST`, and `MUXIMO_WEB_PORT` in the copied
file. Changing this machine-specific URL requires a native rebuild, but does
not require a Capacitor sync. Configure the corresponding Web origin in the
muximo instance with `muximo config set daemon.allowedOrigins <origin>`.

The project has three shared schemes:

- `Local` (`Debug`): loads the URL from `local.xcconfig`;
- `Staging` (`Staging`): uses bundled assets and bundle ID `com.muximo.app.staging`;
- `Release` (`Release`): uses bundled assets and bundle ID `com.muximo.app`.

Bundled builds use the fixed `capacitor://localhost` origin. Muximod allows
that first-party origin automatically, so it must not be added to
`MUXIMOD_ALLOWED_ORIGINS`. They do not receive a muximod endpoint at build
time. The first-run flow pairs with `muximo pair`, then stores the connection
profile and browser device key through the client authentication flow.

The `Local` scheme loads the remote Web runtime from `local.xcconfig`, so its
HTTP(S) origin must be included in the instance's `daemon.allowedOrigins`.

## Release CI and App Store Connect

The `TestFlight` workflow is started manually with `workflow_dispatch`. Select the branch in GitHub Actions and run it against the candidate commit. The run summary records the exact ref and commit uploaded to App Store Connect. It does not create a Git tag or GitHub Release.

The final `release` workflow starts from a semantic version tag such as `v0.1.0` or `v0.1.0-beta.1`. It runs repository checks, builds the standalone muximo binaries, uploads the iOS app, and creates the GitHub Release. It does not submit the app to App Review or publish it to the public App Store.

The native marketing version is read from `apps/web/package.json`. TestFlight and release builds receive unique execution-time App Store build numbers.

Before running either workflow, configure these repository-level Actions secrets:

- `IOS_ASC_API_KEY_ID`;
- `IOS_ASC_ISSUER_ID`;
- `IOS_ASC_API_PRIVATE_KEY`;
- `IOS_DIST_CERTIFICATE_BASE64`;
- `IOS_DIST_CERTIFICATE_PASSWORD`;
- `IOS_APP_STORE_PROFILE_BASE64`.

The App Store provisioning profile must target `com.muximo.app`, and the distribution certificate and profile must belong to the same Apple Developer Team.

To start a manual TestFlight build from the command line:

```sh
gh workflow run testflight.yml --ref main
```

After the build has been processed and validated, create the release tag at the exact source SHA recorded by the TestFlight run:

```sh
CANDIDATE_SHA="<the SHA shown in the TestFlight run summary>"
git tag "v0.1.0" "$CANDIDATE_SHA"
git push origin "v0.1.0"
```

## Platform requirements

The generated project targets iOS 15 and uses Capacitor 8. Xcode and the iOS SDK must be installed before opening the project. Refer to the [Capacitor iOS documentation](https://capacitorjs.com/docs/ios) for the supported toolchain.
