import {
  ensureTailscaleServe,
  type Logger,
  localMuximodUrl,
  resolvePairingBaseUrl,
  resolveServeAllowedOrigins,
  resolveServeLogOptions,
  type ServeCommandOptions,
  type ServeMuximodLease,
} from "@muximo/infrastructure/cli-client";
import type { CliServeInput } from "../commands/types.js";

export type PairRouteDependencies = {
  ensureMuximod: (
    options: ServeCommandOptions,
    allowedOrigins: readonly string[],
  ) => Promise<ServeMuximodLease | undefined>;
  runCommand?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  logger?: Logger;
};

/** Resolves the browser endpoint used by pairing without importing muximod. */
export async function resolvePairMuximodBaseUrl(
  input: { withoutServe: boolean; controlSocket?: string; environment: NodeJS.ProcessEnv },
  dependencies: PairRouteDependencies,
): Promise<string> {
  const environment = input.environment;
  const log = resolveServeLogOptions(environment);
  const options: CliServeInput = {
    provider: "tailscale",
    foreground: false,
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
    controlSocket: input.controlSocket,
    muximodBaseUrl: environment.MUXIMOD_PAIRING_BASE_URL?.trim() || undefined,
  };

  if (input.withoutServe) {
    const pairingBaseUrl = environment.MUXIMOD_PAIRING_BASE_URL
      ? resolvePairingBaseUrl(environment)
      : localMuximodUrl(options.muximodHost, options.muximodPort);
    const allowedOrigins =
      environment.MUXIMOD_ALLOWED_ORIGINS === undefined
        ? [new URL(pairingBaseUrl).origin]
        : resolveServeAllowedOrigins(options, environment);
    await dependencies.ensureMuximod(serveOptions, allowedOrigins);
    return pairingBaseUrl;
  }

  const result = await ensureTailscaleServe(
    serveOptions,
    {
      ensureMuximod: dependencies.ensureMuximod,
      runCommand: dependencies.runCommand,
      logger: dependencies.logger,
    },
    environment,
  );
  if (!result.url) {
    throw new Error(
      "could not determine the Tailscale Serve URL; set MUXIMO_TAILSCALE_HOSTNAME or MUXIMOD_PAIRING_BASE_URL",
    );
  }
  return result.url;
}

function readPort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("muximod port must be between 1 and 65535");
  return port;
}
