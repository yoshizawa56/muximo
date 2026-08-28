#!/usr/bin/env bun
import {
  type PortlessProcessHandle,
  type PortlessService,
  type PortlessServiceRoute,
  resolvePortlessRoute,
  resolveRepositoryRoot,
  spawnPortlessService,
  waitForPortlessRoute,
} from "@muximo/portless-support";

const repositoryRoot = resolveRepositoryRoot();
const environment = { ...process.env };
const routeAbort = new AbortController();
const children: ManagedChild[] = [];

let shuttingDown = false;
let stopPromise: Promise<void> | undefined;
let shutdownCode: number | undefined;
const stop = (signal: "SIGINT" | "SIGTERM", requestedExitCode?: number) => {
  if (shuttingDown) return stopPromise;
  shuttingDown = true;
  shutdownCode = requestedExitCode;
  routeAbort.abort();
  stopPromise = Promise.all(
    children.map(async ({ handle }) => {
      try {
        handle.terminate(signal);
      } catch {
        // Continue cleaning up every child when one termination signal fails.
      }
      await handle.wait().catch(() => undefined);
    }),
  ).then(() => undefined);
  return stopPromise;
};
const onSigint = () => void stop("SIGINT", 130);
const onSigterm = () => void stop("SIGTERM", 143);
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

try {
  children.push(startChild("web"));
  children.push(startChild("muximod", ["serve", "tailscale", "--foreground"]));
  const readiness = await Promise.race([
    waitForRoutes().then((routes) => ({ kind: "ready" as const, routes })),
    waitForChildExit(),
  ]);

  if (readiness.kind === "child-exit") {
    if (!shuttingDown) await stop("SIGTERM");
    process.exitCode = shutdownCode ?? (readiness.code === 0 ? 1 : readiness.code);
  } else {
    console.log(`[serve] web: ${readiness.routes.web.publicUrl}`);
    console.log(`[serve] muximod: ${readiness.routes.muximod.publicUrl}`);
    const outcome = await Promise.race([waitForChildExit(), monitorRoutes(readiness.routes)]);
    if (!shuttingDown) await stop("SIGTERM");
    process.exitCode = shutdownCode ?? (outcome.kind === "route-failure" ? 1 : outcome.code === 0 ? 1 : outcome.code);
    if (outcome.kind === "route-failure") {
      console.error(`[serve] ${outcome.message}`);
    }
  }
} catch (error) {
  if (!shuttingDown) {
    await stop("SIGTERM");
    console.error(`[serve] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } else {
    process.exitCode = shutdownCode ?? 1;
  }
} finally {
  routeAbort.abort();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  await stopPromise;
}

type ManagedChild = {
  service: PortlessService;
  handle: PortlessProcessHandle;
};

type ChildExit = {
  kind: "child-exit";
  service: PortlessService;
  code: number;
};

type RouteFailure = {
  kind: "route-failure";
  message: string;
};

function startChild(service: PortlessService, args: readonly string[] = []): ManagedChild {
  return {
    service,
    handle: spawnPortlessService(service, {
      repositoryRoot,
      environment,
      args,
    }),
  };
}

async function waitForRoutes(): Promise<{ web: PortlessServiceRoute; muximod: PortlessServiceRoute }> {
  const [web, muximod] = await Promise.all([
    waitForPortlessRoute("web", { repositoryRoot, environment, signal: routeAbort.signal }),
    waitForPortlessRoute("muximod", { repositoryRoot, environment, signal: routeAbort.signal }),
  ]);
  return { web, muximod };
}

async function waitForChildExit(): Promise<ChildExit> {
  const result = await Promise.race(
    children.map(async ({ service, handle }) => ({ kind: "child-exit" as const, service, code: await handle.wait() })),
  );
  return result;
}

async function monitorRoutes(initial: {
  web: PortlessServiceRoute;
  muximod: PortlessServiceRoute;
}): Promise<RouteFailure> {
  while (!routeAbort.signal.aborted) {
    for (const service of ["web", "muximod"] as const) {
      const route = resolvePortlessRoute(service, { repositoryRoot, environment });
      if (!route) return { kind: "route-failure", message: `${service} Portless route was lost` };
      if (route.routePid !== initial[service].routePid) {
        return { kind: "route-failure", message: `${service} Portless route owner changed` };
      }
    }
    await wait(250);
  }
  return { kind: "route-failure", message: "development supervisor stopped" };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
