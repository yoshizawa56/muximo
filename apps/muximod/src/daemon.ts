import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultOpenCodeRegistryFile, OpenCodeServerManager, createLogger, defaultLogFile, errorFields, errorMessage, parseLogLevel, resolveMuximodPaths, validateMuximodControlSocketPath, type LogLevel, type Logger } from "@muximo/infrastructure";
import { createMuximodServer } from "./server.js";

export type MuximodCliOptions = {
  host: string;
  port: number;
  pidFile: string;
  controlSocket?: string;
  muximodBaseUrl?: string;
  logLevel?: LogLevel;
  logFile?: string;
  refreshServers?: boolean;
};

type MuximodCommand = "start" | "status" | "stop" | "restart" | "ensure";

type MuximodPidRecord = {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
};

/**
 * A restart marker next to the pid file tells a stopping daemon to leave the
 * owned OpenCode servers running and, when a refresh was requested, the
 * replacing daemon to restart them on their existing ports so configuration or
 * environment changes are picked up while the server URLs stay stable. The
 * marker is consumed by the replacing daemon at boot; stale markers left by a
 * crashed restart are cleared there.
 */
export function restartMarkerPath(pidFile: string): string {
  return `${pidFile}.restart`;
}

export function writeRestartMarker(pidFile: string, refreshServers: boolean): void {
  const path = restartMarkerPath(pidFile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ pid: process.pid, refreshServers, startedAt: new Date().toISOString() })}\n`, { mode: 0o600 });
}

/** Report whether a restart was requested, without removing the marker. */
export function hasRestartMarker(pidFile: string): boolean {
  return existsSync(restartMarkerPath(pidFile));
}

/** Remove the marker if present; returns the refresh flag, or undefined when absent. */
export function consumeRestartMarker(pidFile: string): boolean | undefined {
  const path = restartMarkerPath(pidFile);
  if (!existsSync(path)) return undefined;
  let refreshServers = true;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { refreshServers?: unknown };
    refreshServers = parsed.refreshServers !== false;
  } catch {
    // An unreadable marker defaults to a plain restart (keep servers).
  }
  try {
    unlinkSync(path);
  } catch {
    // The marker may already have been removed; its presence already signaled a restart.
  }
  return refreshServers;
}

function removeRestartMarker(pidFile: string): void {
  const path = restartMarkerPath(pidFile);
  try {
    unlinkSync(path);
  } catch {
    // No marker to remove.
  }
}

type ParsedMuximodOptions = {
  options: MuximodCliOptions;
  foreground: boolean;
};

const healthTimeoutMs = 500;
const lifecycleTimeoutMs = 5_000;
const healthLogScanLimit = 64;
const healthDiagnosticLimit = 5;
const healthDiagnosticMessageLimit = 512;

type MuximodHealthFailureContext = {
  startedAt: number;
  pid?: number;
};

export async function runMuximodCommand(args: string[] = []): Promise<ReturnType<typeof createMuximodServer> | undefined> {
  const { command, rest } = normalizeCommand(args);
  if (rest.includes("-h") || rest.includes("--help")) {
    printUsage(command);
    return undefined;
  }

  const parsed = parseMuximodOptions(rest);
  const options = parsed.options;
  switch (command) {
    case "start":
      if (parsed.foreground) return startMuximod(options);
      process.exitCode = await ensureMuximod(options);
      return undefined;
    case "status":
      process.exitCode = await statusMuximod(options);
      return undefined;
    case "stop":
      process.exitCode = await stopMuximod(options);
      return undefined;
    case "restart":
      process.exitCode = await restartMuximod(options);
      return undefined;
    case "ensure":
      process.exitCode = await ensureMuximod(options);
      return undefined;
  }
}

export async function startMuximod(args: string[] | MuximodCliOptions = []): Promise<ReturnType<typeof createMuximodServer> | undefined> {
  const options = Array.isArray(args) ? parseMuximodOptions(normalizeStartCommand(args)).options : args;
  const logger = createLogger({
    service: "muximod",
    mode: options.logFile ? "background" : "attached",
    level: options.logLevel ?? "info",
    logFile: options.logFile,
    output: process.stderr,
    showStack: options.logLevel === "debug",
  });
  const app = createMuximodServer({ ...options, logger });

  try {
    await app.start();
    writePidRecord(options.pidFile, {
      pid: process.pid,
      host: options.host,
      port: options.port,
      startedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("process.unhandled_error", {
      message: `unexpected error: ${errorMessage(error)}`,
      ...errorFields(error),
    });
    app.stop();
    logger.close();
    throw error;
  }

  // A restart keeps the owned OpenCode servers running. When the marker asked
  // for a refresh, replace them on their existing ports so configuration or
  // environment changes are picked up; otherwise keep them so running sessions
  // are not interrupted. The marker is consumed here, and stale markers from a
  // crashed restart are cleared too. Best effort: a failed refresh must not
  // block the daemon.
  if (consumeRestartMarker(options.pidFile) === true) {
    void refreshOwnedOpenCodeServers({
      logger,
      registryFile: defaultOpenCodeRegistryFile(process.env),
    });
  }

  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    removePidRecord(options.pidFile, process.pid);
    // A restart keeps the owned OpenCode servers running so running sessions
    // are not interrupted (and the replacing daemon can refresh them on the
    // same ports when asked); only an explicit stop releases them so they are
    // not orphaned when the daemon exits. Best effort: a failed cleanup must
    // not block or fail the shutdown.
    if (hasRestartMarker(options.pidFile)) {
      app.stop();
      logger.close();
      return;
    }
    void disposeOwnedOpenCodeServers({
      logger,
      registryFile: defaultOpenCodeRegistryFile(process.env),
    }).finally(() => {
      app.stop();
      logger.close();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return app;
}

/**
 * Stop every OpenCode server recorded in the Muximo owned-server
 * registry. Entries pointing at processes this user cannot signal (EPERM) are
 * never force-stopped; the registry is cleared so stale ownership is not kept.
 */
export async function disposeOwnedOpenCodeServers(options: { registryFile: string; logger?: Logger }): Promise<void> {
  const manager = new OpenCodeServerManager({
    registryFile: options.registryFile,
    onLog: (level, message, extra) => {
      if (level === "warn" || level === "error") {
        options.logger?.warn("opencode.server_cleanup", { message, ...extra });
      } else {
        options.logger?.debug("opencode.server_cleanup", { message, ...extra });
      }
    },
  });
  try {
    await manager.disposeAll();
  } catch (error) {
    options.logger?.warn("opencode.server_cleanup_failed", {
      ...errorFields(error),
    });
  }
}

/**
 * Restart every owned OpenCode server on the port it already uses, so a
 * `muximo daemon restart` picks up configuration and environment changes while
 * keeping the server URLs stable. Best effort; failures are logged and the
 * affected root is released from the registry.
 */
export async function refreshOwnedOpenCodeServers(options: { registryFile: string; logger?: Logger }): Promise<void> {
  const manager = new OpenCodeServerManager({
    registryFile: options.registryFile,
    onLog: (level, message, extra) => {
      if (level === "warn" || level === "error") {
        options.logger?.warn("opencode.server_refresh", { message, ...extra });
      } else {
        options.logger?.debug("opencode.server_refresh", { message, ...extra });
      }
    },
  });
  try {
    await manager.refreshAll();
  } catch (error) {
    options.logger?.warn("opencode.server_refresh_failed", {
      ...errorFields(error),
    });
  }
}

function normalizeCommand(args: string[]): { command: MuximodCommand; rest: string[] } {
  const [command, ...rest] = args;
  if (!command || command.startsWith("-")) return { command: "start", rest: args };
  if (isMuximodCommand(command)) return { command, rest };
  throw new Error(`unknown muximo daemon command: ${command}`);
}

function normalizeStartCommand(args: string[]): string[] {
  const [command, ...rest] = args;
  if (!command || command.startsWith("-")) return args;
  if (command === "start") return rest;
  throw new Error(`unknown muximo daemon command: ${command}`);
}

function isMuximodCommand(value: string): value is MuximodCommand {
  return value === "start" || value === "status" || value === "stop" || value === "restart" || value === "ensure";
}

function parseMuximodOptions(args: string[]): ParsedMuximodOptions {
  let host = process.env.MUXIMOD_HOST ?? "127.0.0.1";
  let port = Number(process.env.MUXIMOD_PORT ?? 4317);
  const paths = resolveMuximodPaths(process.env);
  let pidFile = paths.pidFile;
  let controlSocket = paths.controlSocket;
  let muximodBaseUrl = process.env.MUXIMOD_PAIRING_BASE_URL;
  let logLevel = parseLogLevel(process.env.MUXIMO_LOG_LEVEL, "info");
  let logFile = process.env.MUXIMO_LOG_FILE;
  let foreground = false;
  let refreshServers = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--foreground") foreground = true;
    else if (argument === "--refresh-servers") refreshServers = true;
    else if (argument === "--host") host = requireValue(argument, args[++index]);
    else if (argument.startsWith("--host=")) host = argument.slice("--host=".length);
    else if (argument === "--port") port = parsePort(argument, requireValue(argument, args[++index]));
    else if (argument.startsWith("--port=")) port = parsePort("--port", argument.slice("--port=".length));
    else if (argument === "--pid-file") pidFile = resolve(requireValue(argument, args[++index]));
    else if (argument.startsWith("--pid-file=")) pidFile = resolve(argument.slice("--pid-file=".length));
    else if (argument === "--control-socket") controlSocket = requireValue(argument, args[++index]);
    else if (argument.startsWith("--control-socket=")) controlSocket = argument.slice("--control-socket=".length);
    else if (argument === "--muximod-base-url") muximodBaseUrl = requireValue(argument, args[++index]);
    else if (argument.startsWith("--muximod-base-url=")) muximodBaseUrl = argument.slice("--muximod-base-url=".length);
    else if (argument === "--log-level") logLevel = parseRequiredLogLevel(argument, requireValue(argument, args[++index]));
    else if (argument.startsWith("--log-level=")) logLevel = parseRequiredLogLevel("--log-level", argument.slice("--log-level=".length));
    else if (argument === "--log-file") logFile = resolve(requireValue(argument, args[++index]));
    else if (argument.startsWith("--log-file=")) logFile = resolve(argument.slice("--log-file=".length));
    else throw new Error(`unknown muximo daemon option: ${argument}`);
  }

  validateMuximodControlSocketPath(controlSocket);
  const options: MuximodCliOptions = { host, port, pidFile, controlSocket, muximodBaseUrl, logLevel, logFile };
  if (refreshServers) options.refreshServers = true;
  return { options, foreground };
}

async function statusMuximod(options: MuximodCliOptions): Promise<number> {
  const healthCheckStartedAt = Date.now();
  if (await isHealthy(options)) {
    const record = readPidRecord(options.pidFile);
    process.stdout.write(`muximod running${record ? ` (pid ${record.pid})` : ""} at http://${displayHost(options.host)}:${options.port}\n`);
    return 0;
  }

  const record = readPidRecord(options.pidFile);
  if (record && isProcessAlive(record.pid)) {
    process.stderr.write(`${formatMuximodHealthFailure(
      `muximod process ${record.pid} exists but is not healthy at http://${displayHost(options.host)}:${options.port}`,
      options,
      { startedAt: healthCheckStartedAt, pid: record.pid },
    )}\n`);
    return 1;
  }

  if (record) removePidRecord(options.pidFile, record.pid);
  process.stdout.write(`muximod stopped at http://${displayHost(options.host)}:${options.port}\n`);
  return 1;
}

async function stopMuximod(options: MuximodCliOptions, quiet = false): Promise<number> {
  const healthCheckStartedAt = Date.now();
  const record = readPidRecord(options.pidFile);
  if (!record) {
    if (await isHealthy(options)) {
      throw new Error(`muximod is healthy but its pid file is missing: ${options.pidFile}; stop it through its service manager`);
    }
    if (!quiet) process.stdout.write("muximod is already stopped\n");
    return 0;
  }

  if (!isProcessAlive(record.pid)) {
    removePidRecord(options.pidFile, record.pid);
    if (!quiet) process.stdout.write("muximod was already stopped; removed stale pid file\n");
    return 0;
  }

  const recordOptions = { ...options, host: record.host, port: record.port };
  if (!(await isHealthy(recordOptions))) {
    throw new Error(formatMuximodHealthFailure(
      `refusing to signal pid ${record.pid}; pid file does not point to a healthy muximod`,
      options,
      { startedAt: healthCheckStartedAt, pid: record.pid },
    ));
  }

  process.kill(record.pid, "SIGTERM");
  const stopped = await waitFor(() => !isProcessAlive(record.pid), lifecycleTimeoutMs);
  if (!stopped) throw new Error(`muximod pid ${record.pid} did not stop within ${lifecycleTimeoutMs}ms`);
  removePidRecord(options.pidFile, record.pid);
  if (!quiet) process.stdout.write("muximod stopped\n");
  return 0;
}

async function restartMuximod(options: MuximodCliOptions): Promise<number> {
  // Tell the running daemon to keep its OpenCode servers alive so sessions keep
  // their ports across the restart. With --refresh-servers the replacing daemon
  // restarts them on the same ports so configuration changes are picked up.
  // Consumed by the replacing daemon at boot; cleared by a failed restart so a
  // later stop still cleans up.
  writeRestartMarker(options.pidFile, options.refreshServers === true);
  try {
    await stopMuximod(options, true);
  } catch (error) {
    removeRestartMarker(options.pidFile);
    throw error;
  }

  // launchd/systemd may restart a KeepAlive service as soon as its old process
  // exits. Reuse that process when it becomes healthy before spawning a second
  // one ourselves.
  if (await waitFor(() => isHealthy(options), 1_000)) {
    process.stdout.write(`muximod restarted by its service manager at http://${displayHost(options.host)}:${options.port}\n`);
    return 0;
  }

  const startupStartedAt = Date.now();
  const child = spawnCurrentDaemon(options);
  if (!(await waitFor(() => isHealthy(options), lifecycleTimeoutMs))) {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may have exited already; preserve the useful health error.
    }
    throw new Error(formatMuximodHealthFailure(
      `muximod did not become healthy at http://${displayHost(options.host)}:${options.port}`,
      options,
      { startedAt: startupStartedAt, pid: child.pid },
    ));
  }
  process.stdout.write(`muximod restarted at http://${displayHost(options.host)}:${options.port}\n`);
  return 0;
}

async function ensureMuximod(options: MuximodCliOptions): Promise<number> {
  const healthCheckStartedAt = Date.now();
  if (await isHealthy(options)) {
    process.stdout.write(`muximod already running at http://${displayHost(options.host)}:${options.port}\n`);
    return 0;
  }

  const record = readPidRecord(options.pidFile);
  if (record && isProcessAlive(record.pid)) {
    throw new Error(formatMuximodHealthFailure(
      `muximod pid ${record.pid} exists but is not healthy; use 'muximo daemon restart'`,
      options,
      { startedAt: healthCheckStartedAt, pid: record.pid },
    ));
  }

  const startupStartedAt = Date.now();
  const child = spawnCurrentDaemon(options);
  if (!(await waitFor(() => isHealthy(options), lifecycleTimeoutMs))) {
    try {
      child.kill("SIGTERM");
    } catch {
      // The child may have exited already; preserve the useful health error.
    }
    throw new Error(formatMuximodHealthFailure(
      `muximod did not become healthy at http://${displayHost(options.host)}:${options.port}`,
      options,
      { startedAt: startupStartedAt, pid: child.pid },
    ));
  }
  process.stdout.write(`muximod started at http://${displayHost(options.host)}:${options.port}\n`);
  return 0;
}

export function buildDaemonSpawnArgs(options: MuximodCliOptions, entry = process.argv[1]): string[] {
  const sourceEntry = entry && /\.(?:[cm]?js|ts)$/.test(entry) && existsSync(entry);
  const args = sourceEntry ? [entry, "daemon", "start", "--foreground"] : ["daemon", "start", "--foreground"];
  args.push("--host", options.host, "--port", String(options.port), "--pid-file", options.pidFile);
  if (options.controlSocket) args.push("--control-socket", options.controlSocket);
  if (options.muximodBaseUrl) args.push("--muximod-base-url", options.muximodBaseUrl);
  args.push("--log-level", options.logLevel ?? "info", "--log-file", options.logFile ?? defaultLogFile());
  return args;
}

export function formatMuximodHealthFailure(
  message: string,
  options: Pick<MuximodCliOptions, "logFile">,
  context: MuximodHealthFailureContext,
): string {
  const logFile = resolve(options.logFile ?? defaultLogFile());
  const diagnostics = readRecentMuximodDiagnostics(logFile, context);
  const lines = [message, `muximod log: ${logFile}`];
  if (diagnostics.length === 0) {
    lines.push("muximod log: no recent warning or error records");
  } else {
    lines.push("muximod recent diagnostics:", ...diagnostics.map((diagnostic) => `  ${diagnostic}`));
  }
  return lines.join("\n");
}

function readRecentMuximodDiagnostics(logFile: string, context: MuximodHealthFailureContext): string[] {
  let lines: string[];
  try {
    lines = readFileSync(logFile, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
  } catch {
    return [];
  }

  return lines
    .slice(-healthLogScanLimit)
    .map((line) => formatMuximodDiagnostic(line, context))
    .filter((diagnostic): diagnostic is string => diagnostic !== undefined)
    .slice(-healthDiagnosticLimit);
}

function formatMuximodDiagnostic(line: string, context: MuximodHealthFailureContext): string | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }

  const record = asRecord(value);
  if (!record || (record.level !== "warn" && record.level !== "error")) return undefined;
  const timestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN;
  if (!Number.isFinite(timestamp) || timestamp < context.startedAt) return undefined;
  if (context.pid !== undefined && record.pid !== context.pid) return undefined;
  const fields = asRecord(record.fields);
  const error = asRecord(fields?.error);
  const level = String(record.level).toUpperCase();
  const event = typeof record.event === "string" ? record.event : "unknown";
  const message = typeof fields?.message === "string"
    ? fields.message
    : typeof error?.message === "string"
      ? error.message
      : undefined;
  const code = typeof error?.code === "string" || typeof error?.code === "number" ? String(error.code) : undefined;
  const errorId = typeof fields?.errorId === "string" ? fields.errorId : undefined;
  const detail = message ? `: ${truncateHealthDiagnostic(errorMessage(message))}` : "";
  const codeDetail = code ? ` code=${code}` : "";
  const idDetail = errorId ? ` errorId=${errorId}` : "";
  return `${level} ${event}${detail}${codeDetail}${idDetail}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function truncateHealthDiagnostic(value: string): string {
  return value.length <= healthDiagnosticMessageLimit
    ? value
    : `${value.slice(0, healthDiagnosticMessageLimit - 1)}…`;
}

function spawnCurrentDaemon(options: MuximodCliOptions) {
  const args = buildDaemonSpawnArgs(options);
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    detached: true,
    env: process.env,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

async function isHealthy(options: Pick<MuximodCliOptions, "host" | "port">): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), healthTimeoutMs);
  try {
    const response = await fetch(`http://${displayHost(options.host)}:${options.port}/health`, { signal: controller.signal });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: boolean; service?: string };
    return body.ok === true && body.service === "muximod";
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  return await condition();
}

function readPidRecord(path: string): MuximodPidRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(path, "utf8")) as Partial<MuximodPidRecord>;
    if (!Number.isInteger(record.pid) || !record.host || !Number.isInteger(record.port)) return undefined;
    return record as MuximodPidRecord;
  } catch {
    return undefined;
  }
}

function writePidRecord(path: string, record: MuximodPidRecord): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function removePidRecord(path: string, expectedPid: number): void {
  const record = readPidRecord(path);
  if (record?.pid !== expectedPid) return;
  try {
    unlinkSync(path);
  } catch {
    // Another lifecycle command may have removed the stale record already.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function requireValue(option: string, value: string | undefined): string {
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}

function parseRequiredLogLevel(option: string, value: string): LogLevel {
  if (value !== "error" && value !== "warn" && value !== "info" && value !== "debug") {
    throw new Error(`${option} must be one of error, warn, info, or debug`);
  }
  return value;
}

function parsePort(option: string, value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${option} must be between 1 and 65535`);
  return port;
}

function displayHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function printUsage(command: MuximodCommand): void {
  const usage = command === "start"
    ? "Usage: muximo daemon start [--foreground] [--host HOST] [--port PORT] [--pid-file PATH] [--control-socket PATH] [--muximod-base-url URL] [--log-level LEVEL] [--log-file PATH]"
    : command === "restart"
      ? "Usage: muximo daemon restart [--refresh-servers] [--host HOST] [--port PORT] [--pid-file PATH] [--log-level LEVEL] [--log-file PATH]"
      : `Usage: muximo daemon ${command} [--host HOST] [--port PORT] [--pid-file PATH] [--log-level LEVEL] [--log-file PATH]`;
  const behavior = command === "start"
    ? "Starts muximod in the background and waits until it is healthy by default. Use --foreground when a service manager should own the muximod process."
    : command === "restart"
      ? "Stops muximod and starts it in the background, unless a service manager takes over the replacement process. Running OpenCode servers are kept; use --refresh-servers to restart them on the same ports so configuration or environment changes are picked up."
      : undefined;
  process.stdout.write(`${usage}\n${behavior ? `\n${behavior}\n` : ""}\nCommands: start, status, stop, restart, ensure\n`);
}
