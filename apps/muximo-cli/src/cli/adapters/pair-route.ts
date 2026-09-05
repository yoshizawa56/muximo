import { muximodHealthProbeSchema, muximodHealthSchema } from "@muximo/contract/api";
import { protocolVersion } from "@muximo/contract/shared";
import {
  createTailscaleServeClient,
  hasTailscaleServeRoute,
  readServeRouteState,
  type ServeRouteState,
} from "@muximo/infrastructure/cli-client";
import { MuximodProtocolCompatibilityError } from "@muximo/muximod/client";

export type PairRouteInput = {
  withoutServe: boolean;
  localMuximodBaseUrl: string;
  routeStateFile: string;
  tailscaleEnvironment: NodeJS.ProcessEnv;
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
    await verifyMuximodRoute(input.localMuximodBaseUrl);
    return input.localMuximodBaseUrl;
  }

  const state = readServeRouteState(input.routeStateFile);
  if (!state) {
    throw new Error(`muximod Serve route is unavailable; run "muximo serve tailscale" first`);
  }
  if (state.component !== "muximod") {
    throw new Error(`muximod Serve route belongs to a different component: ${input.routeStateFile}`);
  }
  const routeMatchesLiveProvider = await (dependencies.verifyLiveRoute ?? verifyLiveRoute)(
    state,
    input.tailscaleEnvironment,
  );
  if (!routeMatchesLiveProvider) {
    throw new Error(`muximod Serve route state does not match the live provider configuration`);
  }
  await verifyMuximodRoute(state.publicUrl);
  return state.publicUrl;
}

async function verifyLiveRoute(state: ServeRouteState, environment: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await createTailscaleServeClient({ environment }).status();
  return hasTailscaleServeRoute(result.stdout, state);
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
    const payload = await response.json();
    const probe = muximodHealthProbeSchema.safeParse(payload);
    if (!probe.success) {
      throw new Error("muximod Serve health check returned an unexpected service");
    }
    if (probe.data.protocolVersion !== protocolVersion) {
      throw new MuximodProtocolCompatibilityError(protocolVersion, probe.data.protocolVersion);
    }
    if (!muximodHealthSchema.safeParse(payload).success) {
      throw new Error("muximod Serve health check returned an invalid health response");
    }
  } catch (error) {
    if (error instanceof MuximodProtocolCompatibilityError) throw error;
    if (error instanceof Error && error.message.startsWith("muximod Serve health check")) throw error;
    throw new Error(`muximod Serve route is not reachable: ${baseUrl}`, { cause: error });
  } finally {
    clearTimeout(timeout);
  }
}
