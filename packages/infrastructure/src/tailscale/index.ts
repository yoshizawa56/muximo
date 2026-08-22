import { accessSync, constants } from "node:fs";
import { join } from "node:path";

export { getLocalTerminal } from "./local-terminal.js";

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
  stdoutMarkers?: {
    start: string;
    end: string;
  };
};

export type TailscaleInvocationOptions = {
  isExecutable?: (path: string) => boolean;
  allowShellFallback?: boolean;
};

const shellStdoutStartMarker = "__muximo_tailscale_stdout_begin__";
const shellStdoutEndMarker = "__muximo_tailscale_stdout_end__";

/**
 * Builds the child-process invocation for the Tailscale CLI.
 *
 * Prefer a real executable so a daemon does not need to load the user's full
 * interactive shell configuration. If only a shell alias or function exists,
 * fall back to the user's interactive shell. The macOS App-Store CLI bundle
 * is added as a direct executable fallback for the standard `tailscale` name.
 * Arguments are quoted individually because the shell fallback receives one
 * command string.
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

  if (options.allowShellFallback === false) {
    return { command: binary, args, environment: childEnvironment };
  }

  if (platform === "darwin" && binary === "tailscale") {
    childEnvironment.PATH = appendMacTailscalePaths(childEnvironment.PATH, childEnvironment.HOME);
  }

  const shell = childEnvironment.SHELL ?? (platform === "darwin" ? "/bin/zsh" : "/bin/sh");
  const commandLine = [
    `printf '%s\\n' ${shellQuote(shellStdoutStartMarker)}`,
    [binary, ...args.map(shellQuote)].join(" "),
    "status=$?",
    `printf '%s\\n' ${shellQuote(shellStdoutEndMarker)}`,
    'exit "$status"',
  ].join("; ");
  return {
    command: shell,
    args: ["-ic", commandLine],
    environment: childEnvironment,
    stdoutMarkers: { start: shellStdoutStartMarker, end: shellStdoutEndMarker },
  };
}

export function normalizeTailscaleStdout(stdout: string, invocation: TailscaleInvocation): string {
  const markers = invocation.stdoutMarkers;
  if (!markers) return stdout;

  const startIndex = stdout.indexOf(markers.start);
  if (startIndex < 0) return stdout;
  let payloadStart = startIndex + markers.start.length;
  if (stdout.startsWith("\r\n", payloadStart)) payloadStart += 2;
  else if (stdout.startsWith("\n", payloadStart)) payloadStart += 1;

  const endIndex = stdout.indexOf(markers.end, payloadStart);
  return stdout.slice(payloadStart, endIndex < 0 ? stdout.length : endIndex);
}

/**
 * Builds a persistent HTTPS reverse-proxy configuration. The local target is
 * deliberately loopback-only: Tailscale terminates HTTPS and keeps the
 * public-facing listener separate from the worktree-specific local port.
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

  const normalizedHost = hostname.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!normalizedHost) throw new Error("Tailscale Serve hostname is required");
  const url = new URL(`https://${normalizedHost}`);
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
  const normalizedHost = hostname.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `wss://${normalizedHost}${normalizedPath}`;
}

function normalizePath(path: string): string {
  const normalized = path.trim();
  if (!normalized || normalized === "/") return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function isShellCommandName(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(value);
}

function hasExecutableOnPath(binary: string, path: string | undefined, platform: NodeJS.Platform, isExecutable: (path: string) => boolean): boolean {
  const separator = platform === "win32" ? ";" : ":";
  return (path ?? "").split(separator).some((directory) => isExecutable(join(directory || ".", binary)));
}

function bundledTailscaleBinary(binary: string, home: string | undefined, platform: NodeJS.Platform, isExecutable: (path: string) => boolean): string | undefined {
  if (platform !== "darwin" || binary !== "tailscale") return undefined;
  const candidates = [
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ...(home ? [`${home}/Applications/Tailscale.app/Contents/MacOS/Tailscale`] : []),
  ];
  return candidates.find(isExecutable);
}

function appendMacTailscalePaths(path: string | undefined, home: string | undefined): string {
  const entries = (path ?? "").split(":").filter(Boolean);
  const fallbackPaths = [
    "/Applications/Tailscale.app/Contents/MacOS",
    ...(home ? [`${home}/Applications/Tailscale.app/Contents/MacOS`] : []),
  ];
  for (const fallbackPath of fallbackPaths) {
    if (!entries.includes(fallbackPath)) entries.push(fallbackPath);
  }
  return entries.join(":");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function defaultExecutableCheck(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
