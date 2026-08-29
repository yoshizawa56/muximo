#!/usr/bin/env bun
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createTailscaleServeClient,
  createWebDaemonManager,
  hasTailscaleServeRoute,
  readServeRouteState,
  removeServeRouteState,
  type ServeRouteState,
  type TailscaleServeRoute,
  type WebDaemonManager,
  writeServeRouteState,
} from "@muximo/infrastructure/web-client";
import { getProfile, resolveProfileName } from "@muximo/profile";
import { resolveWebOptions, type WebOptions } from "./options.js";

type WebCliContext = {
  options: WebOptions;
  webManager: WebDaemonManager;
  routeStateFile: string;
  tailscale: ReturnType<typeof createTailscaleServeClient>;
};

const sourceRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

process.exitCode = await main();

async function main(): Promise<number> {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (isHelpInvocation(parsed.command)) {
      printHelp();
      return parsed.command.length === 0 ? 2 : 0;
    }
    const cwd = process.cwd();
    const profile = getProfile({
      name: parsed.profileName,
      repositoryRoot: sourceRepositoryRoot,
      baseEnvironment: process.env,
    });
    const webOptions = resolveWebOptions(profile, cwd);
    const repositoryRoot = profile.repositoryRoot;
    const webRoot = join(repositoryRoot, "apps", "web");
    const context: WebCliContext = {
      options: webOptions,
      webManager: createWebDaemonManager({
        instanceDirectory: webOptions.webInstanceDirectory,
        host: webOptions.host,
        port: webOptions.port,
        cwd: webRoot,
        command: process.execPath,
        args: [join(webRoot, "node_modules/vite/bin/vite.js")],
        environment: webOptions.environment,
      }),
      routeStateFile: join(webOptions.webInstanceDirectory, "serve.json"),
      tailscale: createTailscaleServeClient({ environment: webOptions.environment }),
    };
    return (await execute(parsed.command, context)) ?? 0;
  } catch (error) {
    process.stderr.write(`[web] error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function execute(command: string[], context: WebCliContext): Promise<number | undefined> {
  const [group, action] = command;
  if (group === "daemon") {
    if (action === "start") {
      const result = await context.webManager.start();
      process.stdout.write(`[web] daemon running at ${result.url} (pid ${result.pid ?? "unknown"})\n`);
      return 0;
    }
    if (action === "restart") {
      const result = await context.webManager.restart();
      process.stdout.write(`[web] daemon restarted at ${result.url} (pid ${result.pid ?? "unknown"})\n`);
      return 0;
    }
    if (action === "stop") {
      const result = await context.webManager.stop();
      process.stdout.write(`[web] daemon ${result.state === "stopped" ? "stopped" : "was already stopped"}\n`);
      return 0;
    }
    if (action === "status") {
      const result = await context.webManager.status();
      process.stdout.write(
        `[web] daemon ${result.state} at ${result.url}${result.pid ? ` (pid ${result.pid})` : ""}\n`,
      );
      return result.state === "running" ? 0 : 1;
    }
  }
  if (group === "serve") {
    if (action === "tailscale") return applyTailscaleRoute(context);
    if (action === "status") return reportServeStatus(context);
    if (action === "stop") return stopServeRoute(context);
  }
  throw new Error(`unknown command: ${command.join(" ")}`);
}

function isHelpInvocation(command: readonly string[]): boolean {
  return command.length === 0 || command[0] === "help" || command[0] === "--help" || command[0] === "-h";
}

async function applyTailscaleRoute(context: WebCliContext): Promise<number> {
  const daemon = await context.webManager.status();
  if (daemon.state !== "running") {
    throw new Error(`Web daemon is not running; run "web --env ${context.options.environmentName} daemon start" first`);
  }
  const result = await context.tailscale.applyRoute({
    localHost: context.options.host,
    localPort: context.options.port,
    externalPort: context.options.externalPort,
    hostname: context.options.environment.MUXIMO_TAILSCALE_HOSTNAME,
  });
  writeRouteState(context, result.route);
  process.stdout.write(`[web] Tailscale Serve: ${result.route.publicUrl} -> ${result.route.localTarget}\n`);
  if (result.command.stderr) process.stderr.write(result.command.stderr);
  return 0;
}

async function reportServeStatus(context: WebCliContext): Promise<number> {
  const state = readRouteState(context);
  if (!state) {
    process.stdout.write("[web] Serve route is not configured\n");
    return 1;
  }
  const result = await context.tailscale.status();
  process.stdout.write(`[web] Tailscale Serve: ${state.publicUrl}\n${result.stdout}`);
  if (result.stderr) process.stderr.write(result.stderr);
  if (!hasTailscaleServeRoute(result.stdout, state)) {
    process.stderr.write("[web] error: Serve route state does not match the live provider configuration\n");
    return 1;
  }
  return 0;
}

async function stopServeRoute(context: WebCliContext): Promise<number> {
  const state = readRouteState(context);
  if (!state) {
    process.stdout.write("[web] Serve route is already stopped\n");
    return 0;
  }
  await context.tailscale.removeRoute(state);
  removeServeRouteState(context.routeStateFile);
  process.stdout.write(`[web] Tailscale Serve stopped: ${state.publicUrl}\n`);
  return 0;
}

function writeRouteState(context: WebCliContext, route: TailscaleServeRoute): void {
  const state: ServeRouteState = {
    schemaVersion: 1,
    environment: context.options.environmentName,
    component: "web",
    provider: "tailscale",
    hostname: route.hostname,
    publicUrl: route.publicUrl,
    localTarget: route.localTarget,
    externalPort: route.externalPort,
    path: route.path ?? "/",
    routeFingerprint: route.routeFingerprint,
    updatedAt: new Date().toISOString(),
  };
  writeServeRouteState(context.routeStateFile, state);
}

function readRouteState(context: WebCliContext): ServeRouteState | undefined {
  const state = readServeRouteState(context.routeStateFile);
  if (!state) return undefined;
  if (state.environment !== context.options.environmentName || state.component !== "web") {
    throw new Error(`Web Serve state belongs to a different environment: ${context.routeStateFile}`);
  }
  return state;
}

function parseArguments(args: readonly string[]): { profileName?: string; command: string[] } {
  let profileName = resolveProfileName(process.env.MUXIMO_ENV);
  const command: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--env") {
      const candidate = args[++index];
      profileName = resolveProfileName(candidate);
      continue;
    }
    if (value?.startsWith("--env=")) {
      const candidate = value.slice("--env=".length);
      profileName = resolveProfileName(candidate);
      continue;
    }
    command.push(value);
  }
  return { profileName, command };
}

function printHelp(): void {
  process.stdout.write(
    `Usage: web [--env <profile>] <daemon|serve> <start|restart|stop|status|tailscale>\n\n` +
      "Commands:\n" +
      "  daemon start|restart|stop|status  Manage the Web process\n" +
      "  serve tailscale                   Configure the persistent Tailscale route\n" +
      "  serve status|stop                 Inspect or remove the Web route\n",
  );
}
