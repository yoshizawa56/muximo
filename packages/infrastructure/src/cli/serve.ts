import { errorFields, type Logger } from "../logging/index.js";
import {
  buildServeArgs,
  buildServeHttpUrl,
  createTailscaleServeClient,
  type TailscaleCommandRunner,
  type TailscaleServeRoute,
} from "../tailscale/index.js";

export type ServeInput = {
  provider: "tailscale";
  localPort: number;
  externalPort: number;
  path?: string;
};

export type ServeCommandOptions = ServeInput & {
  tailscaleBinary: string;
  hostname?: string;
};

export type TailscaleServeResult = {
  options: ServeCommandOptions;
  route: TailscaleServeRoute;
  serveArgs: string[];
  hostname: string;
  url: string;
  localUrl: string;
  stdout: string;
  stderr: string;
  statusJson: string;
};

export type ServeCommandDependencies = {
  runCommand?: (
    command: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => Promise<{ stdout: string; stderr: string }>;
  logger?: Logger;
};

/** Configures only the muximod external route; process lifecycle is separate. */
export async function ensureTailscaleServe(
  input: ServeInput,
  dependencies: ServeCommandDependencies,
  environment: NodeJS.ProcessEnv,
): Promise<TailscaleServeResult> {
  const options: ServeCommandOptions = {
    ...input,
    tailscaleBinary: environment.TAILSCALE_BIN ?? "tailscale",
    ...(environment.MUXIMO_TAILSCALE_HOSTNAME ? { hostname: environment.MUXIMO_TAILSCALE_HOSTNAME } : {}),
  };
  const run = dependencies.runCommand === undefined ? undefined : adaptCommandRunner(dependencies.runCommand);
  const client = createTailscaleServeClient({
    environment,
    binary: options.tailscaleBinary,
    ...(run === undefined ? {} : { run }),
  });
  const startedAt = Date.now();
  dependencies.logger?.debug("serve.route_started", {
    component: "muximod",
    localPort: input.localPort,
    externalPort: input.externalPort,
  });
  try {
    const result = await client.applyRoute({
      localHost: "127.0.0.1",
      localPort: input.localPort,
      externalPort: input.externalPort,
      path: input.path,
      hostname: options.hostname,
    });
    dependencies.logger?.debug("serve.route_finished", {
      component: "muximod",
      durationMs: Date.now() - startedAt,
    });
    return {
      options,
      route: result.route,
      serveArgs: buildServeArgs({ localPort: input.localPort, externalPort: input.externalPort, path: input.path }),
      hostname: result.route.hostname,
      url: result.route.publicUrl,
      localUrl: `http://127.0.0.1:${input.localPort}`,
      stdout: result.command.stdout,
      stderr: result.command.stderr,
      statusJson: result.statusJson,
    };
  } catch (error) {
    dependencies.logger?.debug("serve.route_failed", {
      component: "muximod",
      durationMs: Date.now() - startedAt,
      ...errorFields(error),
    });
    throw error;
  }
}

export function adaptCommandRunner(
  runCommand: NonNullable<ServeCommandDependencies["runCommand"]>,
): TailscaleCommandRunner {
  return (command, args, options) => runCommand(command, [...args], { env: options.environment });
}

export function localMuximodUrl(host: string, port: number): string {
  const normalizedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const urlHost =
    normalizedHost.includes(":") && !normalizedHost.startsWith("[") ? `[${normalizedHost}]` : normalizedHost;
  return `http://${urlHost}:${port}`;
}

export function normalizeAllowedOrigins(origins: readonly string[]): string[] {
  const normalized = new Set<string>();
  for (const value of origins) {
    const origin = value.trim();
    if (!origin) continue;
    if (origin === "*") throw new Error("wildcard browser origins are not allowed");
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch (error) {
      throw new Error(`invalid browser origin: ${safeUrlForError(origin)}`, { cause: error });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`browser origin must use http or https: ${safeUrlForError(origin)}`);
    }
    if (parsed.username || parsed.password) throw new Error("browser origin must not contain credentials");
    if (parsed.origin !== origin.replace(/\/$/u, "")) {
      throw new Error(`browser origin must not include a path: ${safeUrlForError(origin)}`);
    }
    normalized.add(parsed.origin);
  }
  return [...normalized].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

export function routePublicUrl(route: Pick<TailscaleServeRoute, "hostname" | "externalPort" | "path">): string {
  return buildServeHttpUrl(route.hostname, route.externalPort, route.path);
}

function safeUrlForError(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password) return "<redacted URL>";
    return value;
  } catch {
    return "<invalid URL>";
  }
}
