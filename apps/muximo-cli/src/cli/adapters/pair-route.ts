import {
  createTailscaleServeClient,
  hasTailscaleServeRoute,
  localMuximodUrl,
  readServeRouteState,
  type ServeRouteState,
} from "@muximo/infrastructure/cli-client";

export type PairRouteInput = {
  withoutServe: boolean;
  environment: NodeJS.ProcessEnv;
  routeStateFile: string;
};

export type PairRouteDependencies = {
  verifyLiveRoute?: (state: ServeRouteState, environment: NodeJS.ProcessEnv) => Promise<boolean>;
};

/** Resolves the client-owned muximod route without starting or configuring it. */
export async function resolvePairMuximodBaseUrl(
  input: PairRouteInput,
  dependencies: PairRouteDependencies = {},
): Promise<string> {
  if (input.withoutServe) {
    const localUrl = localMuximodUrl(
      readRequired(input.environment.MUXIMOD_HOST, "MUXIMOD_HOST"),
      readPort(input.environment.MUXIMOD_PORT),
    );
    await verifyMuximodRoute(localUrl);
    return localUrl;
  }

  const state = readServeRouteState(input.routeStateFile);
  if (!state) {
    throw new Error(`muximod Serve route is unavailable; run "muximo serve tailscale" first`);
  }
  const expectedEnvironment = input.environment.MUXIMO_ENV?.trim() || undefined;
  if (state.environment !== expectedEnvironment || state.component !== "muximod") {
    throw new Error(`muximod Serve route belongs to a different environment: ${input.routeStateFile}`);
  }
  const routeMatchesLiveProvider = await (dependencies.verifyLiveRoute ?? verifyLiveRoute)(state, input.environment);
  if (!routeMatchesLiveProvider) {
    throw new Error(`muximod Serve route state does not match the live provider configuration`);
  }
  await verifyMuximodRoute(state.publicUrl);
  return state.publicUrl;
}

function readRequired(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`${name} is missing from resolved CLI options`);
  return value;
}

async function verifyLiveRoute(state: ServeRouteState, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await createTailscaleServeClient({ environment }).status();
  return hasTailscaleServeRoute(result.stdout, state);
}

function readPort(value: string | undefined): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`muximod port must be between 1 and 65535: ${value ?? "<missing>"}`);
  }
  return port;
}

async function verifyMuximodRoute(baseUrl: string): Promise<void> {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/health`;
  url.search = "";
  url.hash = "";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`muximod Serve health check returned HTTP ${response.status}`);
    const payload = (await response.json()) as { ok?: unknown; service?: unknown };
    if (payload.ok !== true || payload.service !== "muximod") {
      throw new Error("muximod Serve health check returned an unexpected service");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("muximod Serve health check")) throw error;
    throw new Error(`muximod Serve route is not reachable: ${baseUrl}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}
