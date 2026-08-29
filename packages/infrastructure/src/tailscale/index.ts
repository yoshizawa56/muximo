import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export { getLocalTerminal } from "./local-terminal.js";
export * from "./route-state.js";
export * from "./serve-client.js";

export type TailscaleServeConfig = {
  localPort: number;
  externalPort: number;
  background?: boolean;
  confirm?: boolean;
  path?: string;
};

export type TailscaleInvocation = {
  command: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
};

export type TailscaleInvocationOptions = {
  isExecutable?: (path: string) => boolean;
};

/**
 * Builds the child-process invocation for the Tailscale CLI.
 *
 * Always returns a direct executable invocation. The macOS App-Store CLI
 * bundle is added as a direct executable fallback for the standard `tailscale`
 * name. Shell aliases and functions are intentionally not supported because
 * loading interactive shell startup files would make command execution
 * unpredictable and expose an avoidable supply-chain boundary.
 */
export function buildTailscaleInvocation(
  binary: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  options: TailscaleInvocationOptions = {},
): TailscaleInvocation {
  const childEnvironment = { ...environment };
  const isExecutable = options.isExecutable ?? defaultExecutableCheck;
  if (platform === "darwin" && childEnvironment.TAILSCALE_BE_CLI === undefined) {
    childEnvironment.TAILSCALE_BE_CLI = "1";
  }

  if (platform === "win32" || binary.includes("/") || !isShellCommandName(binary)) {
    return { command: binary, args, environment: childEnvironment };
  }

  if (hasExecutableOnPath(binary, childEnvironment.PATH, platform, isExecutable)) {
    return { command: binary, args, environment: childEnvironment };
  }

  const bundledBinary = bundledTailscaleBinary(binary, childEnvironment.HOME, platform, isExecutable);
  if (bundledBinary) {
    return { command: bundledBinary, args, environment: childEnvironment };
  }

  return { command: binary, args, environment: childEnvironment };
}

/**
 * Builds a persistent HTTPS reverse-proxy configuration. The local target is
 * deliberately loopback-only: Tailscale terminates HTTPS and keeps the
 * public-facing listener separate from the component's fixed local port.
 */
export function buildServeArgs(config: TailscaleServeConfig): string[] {
  if (!Number.isInteger(config.localPort) || config.localPort < 1 || config.localPort > 65_535) {
    throw new Error(`Invalid Tailscale Serve port: ${config.localPort}`);
  }
  if (!Number.isInteger(config.externalPort) || config.externalPort < 1 || config.externalPort > 65_535) {
    throw new Error(`Invalid Tailscale Serve external port: ${config.externalPort}`);
  }

  const args = ["serve"];
  if (config.background !== false) args.push("--bg");
  args.push(`--https=${config.externalPort}`);
  if (config.confirm !== false) args.push("--yes");
  if (config.path) args.push(`--set-path=${normalizePath(config.path)}`);
  args.push(`http://127.0.0.1:${config.localPort}`);
  return args;
}

export function buildServeHttpUrl(hostname: string, externalPort: number, path = "/"): string {
  if (!Number.isInteger(externalPort) || externalPort < 1 || externalPort > 65_535) {
    throw new Error(`Invalid Tailscale Serve external port: ${externalPort}`);
  }

  const url = parseTailscaleHostnameUrl(hostname);
  if (externalPort !== 443) url.port = String(externalPort);
  url.pathname = normalizePath(path);
  return url.toString();
}

export function parseTailscaleHostname(statusJson: string): string | undefined {
  try {
    const value = JSON.parse(statusJson) as { Self?: { DNSName?: unknown } };
    const hostname = value.Self?.DNSName;
    if (typeof hostname !== "string" || !hostname.trim()) return undefined;
    return hostname.trim().replace(/\.+$/, "");
  } catch {
    return undefined;
  }
}

export function buildServeUrl(hostname: string, path = "/"): string {
  const url = parseTailscaleHostnameUrl(hostname);
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `wss://${url.host}${normalizedPath}`;
}

function parseTailscaleHostnameUrl(value: string): URL {
  const normalizedHost = value
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!normalizedHost) throw new Error("Tailscale Serve hostname is required");
  let url: URL;
  try {
    url = new URL(`https://${normalizedHost}`);
  } catch (error) {
    throw new Error(`invalid Tailscale Serve hostname: ${safeUrlForError(value)}`, { cause: error });
  }
  if (url.username || url.password) throw new Error("Tailscale Serve hostname must not contain credentials");
  if (url.port) throw new Error("Tailscale Serve hostname must not include a port");
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`Tailscale Serve hostname must not include a path: ${safeUrlForError(value)}`);
  }
  return url;
}

function normalizePath(path: string): string {
  const normalized = path.trim();
  if (!normalized || normalized === "/") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function isShellCommandName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}

function hasExecutableOnPath(
  binary: string,
  path: string | undefined,
  platform: NodeJS.Platform,
  isExecutable: (path: string) => boolean,
): boolean {
  const separator = platform === "win32" ? ";" : ":";
  return (path ?? "").split(separator).some((directory) => isExecutable(join(directory || ".", binary)));
}

function bundledTailscaleBinary(
  binary: string,
  home: string | undefined,
  platform: NodeJS.Platform,
  isExecutable: (path: string) => boolean,
): string | undefined {
  if (platform !== "darwin" || binary !== "tailscale") return undefined;
  const candidates = [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ...(home ? [`${home}/Applications/Tailscale.app/Contents/MacOS/Tailscale`] : []),
  ];
  return candidates.find(isExecutable);
}

function defaultExecutableCheck(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
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
