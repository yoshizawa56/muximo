#!/usr/bin/env bun
import { execFile, spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildServeArgs,
  buildServeHttpUrl,
  buildTailscaleInvocation,
  normalizeTailscaleStdout,
  parseTailscaleHostname,
} from "@muximo/infrastructure";
import { loadDevelopmentEnvironment, resolveRepositoryRoot, waitForPortlessRoute } from "@muximo/portless-support";

const execFileAsync = promisify(execFile);
const repositoryRoot = resolveRepositoryRoot(dirname(fileURLToPath(import.meta.url)));
const environment = loadDevelopmentEnvironment({
  repositoryRoot,
  environment: { ...process.env },
});
const tailscaleHostname = await resolveTailscaleHostname(environment);
if (!tailscaleHostname) {
  throw new Error("could not determine the Tailscale hostname; set MUXIMO_TAILSCALE_HOSTNAME and retry");
}

const webExternalPort = readPort(environment.MUXIMO_WEB_SERVE_PORT, 443, "MUXIMO_WEB_SERVE_PORT");
const muximodExternalPort = readPort(environment.MUXIMO_SERVE_PORT, 8444, "MUXIMO_SERVE_PORT");
const webServeUrl = buildServeHttpUrl(tailscaleHostname, webExternalPort);
const muximodServeUrl = buildServeHttpUrl(tailscaleHostname, muximodExternalPort);
const childEnvironment = {
  ...environment,
  MUXIMO_TAILSCALE_HOSTNAME: tailscaleHostname,
  MUXIMOD_PAIRING_BASE_URL: muximodServeUrl,
  MUXIMOD_ALLOWED_ORIGINS: new URL(webServeUrl).origin,
  VITE_ALLOWED_HOSTS: appendValue(environment.VITE_ALLOWED_HOSTS, tailscaleHostname),
};

const turbo = spawn(
  "node",
  ["node_modules/turbo/bin/turbo", "run", "dev", "--filter=@muximo/web", "--filter=@muximo/muximod"],
  {
    cwd: repositoryRoot,
    env: childEnvironment,
    stdio: "inherit",
  },
);
const turboExit = waitForExit(turbo);

let shuttingDown = false;
const stopTurbo = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  turbo.kill(signal);
};
const onSigint = () => stopTurbo("SIGINT");
const onSigterm = () => stopTurbo("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);

try {
  const [webRoute, muximodRoute] = await Promise.all([
    waitForPortlessRoute("web", { repositoryRoot, environment: childEnvironment }),
    waitForPortlessRoute("muximod", { repositoryRoot, environment: childEnvironment }),
  ]);
  await configureTailscaleServe(webRoute.routePort, webExternalPort, childEnvironment);
  await configureTailscaleServe(muximodRoute.routePort, muximodExternalPort, childEnvironment);
  console.log(`[serve] web: ${webServeUrl}`);
  console.log(`[serve] muximod: ${muximodServeUrl}`);

  const result = await turboExit;
  process.exitCode = result.code ?? signalExitCode(result.signal);
} catch (error) {
  console.error(`[serve] ${error instanceof Error ? error.message : String(error)}`);
  stopTurbo("SIGTERM");
  await turboExit.catch(() => undefined);
  process.exitCode = 1;
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

async function configureTailscaleServe(localPort: number, externalPort: number, env: NodeJS.ProcessEnv): Promise<void> {
  const binary = env.TAILSCALE_BIN ?? "tailscale";
  const invocation = buildTailscaleInvocation(binary, buildServeArgs({ localPort, externalPort }), env);
  await execFileAsync(invocation.command, invocation.args, {
    env: invocation.environment,
    encoding: "utf8",
    maxBuffer: 256 * 1024,
    timeout: 15_000,
  });
}

async function resolveTailscaleHostname(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const configured = env.MUXIMO_TAILSCALE_HOSTNAME?.trim().replace(/\.+$/u, "");
  if (configured) return configured;

  const binary = env.TAILSCALE_BIN ?? "tailscale";
  const invocation = buildTailscaleInvocation(binary, ["status", "--json"], env);
  try {
    const result = await execFileAsync(invocation.command, invocation.args, {
      env: invocation.environment,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: 15_000,
    });
    return parseTailscaleHostname(normalizeTailscaleStdout(result.stdout, invocation));
  } catch {
    return undefined;
  }
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function appendValue(current: string | undefined, value: string): string {
  const values = (current ?? "")
    .split(",")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  if (!values.includes(value)) values.push(value);
  return values.join(",");
}

function readPort(value: string | undefined, fallback: number, name: string): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535`);
  }
  return port;
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
