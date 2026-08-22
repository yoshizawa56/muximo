import {
  ensureLocalMuximod,
  ensureTailscaleServe,
  localMuximodUrl,
  parseServeOptions,
  type ServeCommandDependencies,
} from "./serve-command.js";

export type PairRouteDependencies = Pick<ServeCommandDependencies, "ensureMuximod" | "runCommand" | "logger">;

/**
 * Resolves the endpoint that the QR client will use for both claiming and
 * subsequent authenticated connections. Tailscale Serve is the default
 * route; --without-serve keeps the endpoint local for same-host clients or a
 * future local-forward adapter.
 */
export async function resolvePairMuximodBaseUrl(
  input: { withoutServe: boolean; environment: NodeJS.ProcessEnv },
  dependencies: PairRouteDependencies = {},
): Promise<string> {
  const options = parseServeOptions(["tailscale"], input.environment);
  if (input.withoutServe) {
    await (dependencies.ensureMuximod ?? ensureLocalMuximod)(options);
    return localMuximodUrl(options.muximodHost, options.muximodPort);
  }

  const result = await ensureTailscaleServe(options, dependencies, input.environment);
  if (!result.url) {
    throw new Error("could not determine the Tailscale Serve URL; set MUXIMO_TAILSCALE_HOSTNAME or MUXIMOD_PAIRING_BASE_URL");
  }
  return result.url;
}
