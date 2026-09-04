import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { errorMessage } from "../logging/index.js";
import {
  buildServeArgs,
  buildServeHttpUrl,
  buildTailscaleInvocation,
  parseTailscaleHostname,
  type TailscaleServeConfig,
} from "./index.js";

const execFile = promisify(execFileCallback);
const tailscaleCommandTimeoutMs = 15_000;

export type TailscaleCommandResult = {
  stdout: string;
  stderr: string;
};

export type TailscaleCommandRunner = (
  command: string,
  args: readonly string[],
  options: { environment: NodeJS.ProcessEnv },
) => Promise<TailscaleCommandResult>;

export type TailscaleServeRoute = TailscaleServeConfig & {
  hostname: string;
  localTarget: string;
  publicUrl: string;
  routeFingerprint: string;
};

export type TailscaleServeRouteIdentity = Pick<
  TailscaleServeRoute,
  "hostname" | "localTarget" | "externalPort" | "path" | "routeFingerprint"
>;

export type TailscaleServeClient = {
  resolveHostname(): Promise<string>;
  applyRoute(input: {
    localHost: string;
    localPort: number;
    externalPort: number;
    path?: string;
    hostname?: string;
  }): Promise<{ route: TailscaleServeRoute; command: TailscaleCommandResult; statusJson: string }>;
  status(): Promise<TailscaleCommandResult>;
  removeRoute(input: TailscaleServeRouteIdentity): Promise<TailscaleCommandResult>;
};

export type TailscaleServeClientOptions = {
  environment?: NodeJS.ProcessEnv;
  binary?: string;
  /** Optional executable argv prefix; shell aliases are intentionally unsupported. */
  commandArgs?: readonly string[];
  run?: TailscaleCommandRunner;
};

/** Provides provider mechanics without knowing which application owns a route. */
export function createTailscaleServeClient(options: TailscaleServeClientOptions = {}): TailscaleServeClient {
  const environment = options.environment ?? process.env;
  const binary = options.binary ?? environment.TAILSCALE_BIN ?? "tailscale";
  const run = options.run ?? runTailscaleCommand;
  const commandArgs = options.commandArgs ?? readCommandArgs(environment.MUXIMO_TAILSCALE_ARGS);
  const execute = (args: readonly string[]) => run(binary, [...commandArgs, ...args], { environment });

  return {
    async resolveHostname() {
      const result = await execute(["status", "--json"]);
      const hostname = parseTailscaleHostname(result.stdout);
      if (!hostname) throw new Error("Tailscale hostname could not be determined from status");
      return hostname;
    },
    async applyRoute(input) {
      if (input.localHost !== "127.0.0.1") {
        throw new Error(`Tailscale Serve local host must be 127.0.0.1: ${input.localHost}`);
      }
      const hostname = input.hostname ?? (await this.resolveHostname());
      const localTarget = `http://127.0.0.1:${input.localPort}`;
      const config: TailscaleServeConfig = {
        localPort: input.localPort,
        externalPort: input.externalPort,
        path: input.path,
      };
      const command = await execute(buildServeArgs(config));
      const status = await execute(["serve", "status", "--json"]);
      const route: TailscaleServeRoute = {
        ...config,
        hostname,
        localTarget,
        publicUrl: buildServeHttpUrl(hostname, input.externalPort, input.path),
        routeFingerprint: fingerprintRoute({
          hostname,
          localTarget,
          externalPort: input.externalPort,
          path: input.path,
        }),
      };
      if (!hasTailscaleServeRoute(status.stdout, route)) {
        throw new Error(`Tailscale Serve did not report the configured route for ${route.publicUrl}`);
      }
      return { route, command, statusJson: status.stdout };
    },
    status() {
      return execute(["serve", "status", "--json"]);
    },
    async removeRoute(input) {
      if (
        input.routeFingerprint !==
        fingerprintRoute({
          hostname: input.hostname,
          localTarget: input.localTarget,
          externalPort: input.externalPort,
          path: input.path,
        })
      ) {
        throw new Error("refusing to remove a Tailscale Serve route with an invalid identity");
      }
      const status = await execute(["serve", "status", "--json"]);
      if (!hasTailscaleServeRoute(status.stdout, input)) {
        throw new Error(`refusing to remove a changed or missing Tailscale Serve route for ${input.localTarget}`);
      }
      return execute(buildServeStopArgs(input));
    },
  };
}

function readCommandArgs(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("MUXIMO_TAILSCALE_ARGS must be a JSON array of strings", { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("MUXIMO_TAILSCALE_ARGS must be a JSON array of strings");
  }
  return parsed;
}

/** Checks the provider's live JSON before a route is removed or recorded. */
export function hasTailscaleServeRoute(statusJson: string, expected: TailscaleServeRouteIdentity): boolean {
  let value: unknown;
  try {
    value = JSON.parse(statusJson);
  } catch {
    return false;
  }
  return findWebConfigurations(value).some((web) => webConfigurationMatches(web, expected));
}

export function buildServeStopArgs(
  input: Pick<TailscaleServeRoute, "localTarget" | "externalPort" | "path">,
): string[] {
  const args = ["serve", `--https=${input.externalPort}`, "--yes"];
  if (input.path && normalizeServePath(input.path) !== "/") args.push(`--set-path=${normalizeServePath(input.path)}`);
  args.push(input.localTarget, "off");
  return args;
}

export function fingerprintRoute(input: {
  hostname: string;
  localTarget: string;
  externalPort: number;
  path?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        hostname: input.hostname,
        localTarget: input.localTarget,
        externalPort: input.externalPort,
        path: normalizeServePath(input.path),
      }),
      "utf8",
    )
    .digest("hex");
}

async function runTailscaleCommand(
  command: string,
  args: readonly string[],
  options: { environment: NodeJS.ProcessEnv },
): Promise<TailscaleCommandResult> {
  try {
    const invocation = buildTailscaleInvocation(command, [...args], options.environment);
    return await execFile(invocation.command, invocation.args, {
      env: invocation.environment,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: tailscaleCommandTimeoutMs,
    });
  } catch (error) {
    throw new Error(`could not run ${command}: ${errorMessage(error)}`, { cause: error });
  }
}

function normalizeServePath(path: string | undefined): string {
  const normalized = path?.trim();
  if (!normalized || normalized === "/") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function findWebConfigurations(value: unknown): Array<Record<string, unknown>> {
  if (!isRecord(value)) return [];
  const configurations: Array<Record<string, unknown>> = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === "Web" && isRecord(child)) configurations.push(child);
    configurations.push(...findWebConfigurations(child));
  }
  return configurations;
}

function webConfigurationMatches(web: Record<string, unknown>, expected: TailscaleServeRouteIdentity): boolean {
  const expectedHostname = normalizeHostname(expected.hostname);
  const expectedPath = normalizeServePath(expected.path);
  const expectedTarget = normalizeTarget(expected.localTarget);
  for (const [hostPort, configuration] of Object.entries(web)) {
    const endpoint = parseHostPort(hostPort);
    if (!endpoint || endpoint.hostname !== expectedHostname || endpoint.port !== expected.externalPort) continue;
    if (!isRecord(configuration) || !isRecord(configuration.Handlers)) continue;
    const handler = configuration.Handlers[expectedPath];
    if (!isRecord(handler) || typeof handler.Proxy !== "string") continue;
    if (normalizeTarget(handler.Proxy) === expectedTarget) return true;
  }
  return false;
}

function parseHostPort(value: string): { hostname: string; port: number } | undefined {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return { hostname: normalizeHostname(url.hostname), port: Number(url.port || 443) };
  } catch {
    return undefined;
  }
}

function normalizeHostname(value: string): string {
  return value
    .trim()
    .replace(/^https?:\/\//u, "")
    .replace(/\.+$/u, "")
    .toLowerCase();
}

function normalizeTarget(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return value.trim().replace(/\/+$/u, "");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
