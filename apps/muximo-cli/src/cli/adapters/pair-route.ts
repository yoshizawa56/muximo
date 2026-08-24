import { EnsureDaemon } from "@muximo/application";
import {
  ensureTailscaleServe,
  type Logger,
  localMuximodUrl,
  MuximodDaemonProcess,
  resolveMuximodPaths,
  resolveServeAllowedOrigins,
  resolveServeLogOptions,
  type ServeCommandOptions,
  systemDaemonClock,
  systemDaemonScheduler,
} from "@muximo/infrastructure";
import type { CliServeInput } from "../commands/types.js";

export type PairRouteDependencies = {
  ensureMuximod?: (options: ServeCommandOptions, allowedOrigins: readonly string[]) => Promise<void>;
  runCommand?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  logger?: Logger;
};

/** Resolves the browser endpoint used by pairing without importing muximod. */
export async function resolvePairMuximodBaseUrl(
  input: { withoutServe: boolean; environment: NodeJS.ProcessEnv },
  dependencies: PairRouteDependencies = {},
): Promise<string> {
  const environment = input.environment;
  const log = resolveServeLogOptions(environment);
  const options: CliServeInput = {
    provider: "tailscale",
    muximodHost: environment.MUXIMOD_HOST ?? "127.0.0.1",
    muximodPort: readPort(environment.MUXIMOD_PORT, 4317),
    externalPort: readPort(environment.MUXIMO_SERVE_PORT, 8444),
    pidFile: environment.MUXIMOD_PID_FILE,
    ...log,
  };
  const serveOptions: ServeCommandOptions = {
    ...options,
    tailscaleBinary: environment.TAILSCALE_BIN ?? "tailscale",
    hostname: environment.MUXIMO_TAILSCALE_HOSTNAME,
  };
  const ensureMuximod =
    dependencies.ensureMuximod ??
    (async (serveOptions, allowedOrigins) => {
      const runtime = new MuximodDaemonProcess({ environment });
      await new EnsureDaemon({
        runtime,
        clock: systemDaemonClock,
        scheduler: systemDaemonScheduler,
        lifecycleTimeoutMs: 5_000,
      }).execute({
        host: serveOptions.muximodHost,
        port: serveOptions.muximodPort,
        pidFile: serveOptions.pidFile ?? resolveMuximodPaths(environment).pidFile,
        logLevel: serveOptions.logLevel,
        logFile: serveOptions.logFile,
        allowedOrigins,
      });
    });

  if (input.withoutServe) {
    const allowedOrigins =
      environment.MUXIMOD_ALLOWED_ORIGINS === undefined
        ? [new URL(localMuximodUrl(options.muximodHost, options.muximodPort)).origin]
        : resolveServeAllowedOrigins(options, environment);
    await ensureMuximod(serveOptions, allowedOrigins);
    return localMuximodUrl(options.muximodHost, options.muximodPort);
  }

  const result = await ensureTailscaleServe(
    serveOptions,
    {
      ensureMuximod,
      runCommand: dependencies.runCommand,
      logger: dependencies.logger,
    },
    environment,
  );
  if (!result.url) {
    throw new Error(
      "could not determine the Tailscale Serve URL; set MUXIMO_TAILSCALE_HOSTNAME or MUXIMOD_ALLOWED_ORIGINS",
    );
  }
  return result.url;
}

function readPort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("muximod port must be between 1 and 65535");
  return port;
}
