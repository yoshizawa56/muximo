#!/usr/bin/env bun
import { execFile, execFileSync, spawn as spawnChild } from "node:child_process";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection, createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  buildServeArgs,
  buildServeHttpUrl,
  buildTailscaleInvocation,
  normalizeTailscaleStdout,
  parseTailscaleHostname,
} from "../packages/infrastructure/src/tailscale/index.ts";
import { applyDevWorktreeProfile } from "./worktree-profile.mjs";

export const DEFAULT_DEV_CONFIG = {
  muximodHost: "127.0.0.1",
  muximodPort: 4317,
  webHost: "0.0.0.0",
  webPort: 5227,
  adoptExistingServices: true,
  readyTimeoutMs: 15_000,
  shutdownTimeoutMs: 2_000,
  probeTimeoutMs: 1_500,
};

const scriptPath = fileURLToPath(import.meta.url);
const execFileAsync = promisify(execFile);
const tailscaleCommandTimeoutMs = 15_000;

export class DevRuntimeError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "DevRuntimeError";
    this.service = options.service;
  }
}

export function readPort(name, fallback, environment = process.env) {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new DevRuntimeError(`${name} must be an integer between 1 and 65535`);
  }
  return value;
}

function readDuration(name, fallback, environment) {
  const value = Number(environment[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1) {
    throw new DevRuntimeError(`${name} must be a positive integer number of milliseconds`);
  }
  return value;
}

export function resolveDevConfig(environment = process.env, cwd = process.cwd()) {
  let baseEnvironment = applyDevWorktreeProfile(environment, cwd);
  const muximodHost = baseEnvironment.MUXIMOD_HOST ?? DEFAULT_DEV_CONFIG.muximodHost;
  const muximodPort = readPort(
    "MUXIMOD_PORT",
    baseEnvironment.MUXIMOD_PORT ?? DEFAULT_DEV_CONFIG.muximodPort,
    baseEnvironment,
  );
  const webHost = baseEnvironment.VITE_DEV_HOST ?? DEFAULT_DEV_CONFIG.webHost;
  const webPort = readPort(
    "VITE_DEV_PORT",
    baseEnvironment.VITE_DEV_PORT ?? DEFAULT_DEV_CONFIG.webPort,
    baseEnvironment,
  );
  const muximodProbeHost = probeHostForBind(muximodHost);
  const serveProvider = baseEnvironment.MUXIMO_DEV_SERVE_PROVIDER;
  const servePort = serveProvider
    ? readPort("MUXIMO_DEV_SERVE_PORT", baseEnvironment.MUXIMO_DEV_SERVE_PORT ?? 443, baseEnvironment)
    : undefined;
  if (serveProvider === "tailscale") {
    const hostname = resolveTailscaleHostname(baseEnvironment);
    if (hostname) {
      baseEnvironment = {
        ...baseEnvironment,
        MUXIMO_TAILSCALE_HOSTNAME: hostname,
        VITE_ALLOWED_HOSTS: appendAllowedHost(baseEnvironment.VITE_ALLOWED_HOSTS, hostname),
      };
    }
  }

  baseEnvironment = {
    ...baseEnvironment,
    MUXIMOD_ALLOWED_ORIGINS: resolveDevBrowserOrigins({
      environment: baseEnvironment,
      webHost,
      webPort,
      serveProvider,
      servePort,
    }),
  };

  return {
    ...DEFAULT_DEV_CONFIG,
    repoRoot: cwd,
    baseEnvironment,
    muximodHost,
    muximodPort,
    muximodProbeHost,
    webHost,
    webPort,
    serveProvider,
    servePort,
    // A linked worktree must never silently attach to another worktree's
    // muximod or Vite process. Reusing an existing listener remains available
    // to direct supervisor tests and explicitly constructed configurations.
    adoptExistingServices: false,
    readyTimeoutMs: readDuration("MUXIMO_DEV_READY_TIMEOUT_MS", DEFAULT_DEV_CONFIG.readyTimeoutMs, baseEnvironment),
    shutdownTimeoutMs: readDuration(
      "MUXIMO_DEV_SHUTDOWN_TIMEOUT_MS",
      DEFAULT_DEV_CONFIG.shutdownTimeoutMs,
      baseEnvironment,
    ),
  };
}

function probeHostForBind(host) {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "::1";
  return host;
}

function formatHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function resolveTailscaleHostname(environment) {
  const configured = normalizeHostname(environment.MUXIMO_TAILSCALE_HOSTNAME);
  if (configured) return configured;

  const binary = environment.TAILSCALE_BIN ?? "tailscale";
  try {
    const invocation = buildTailscaleInvocation(binary, ["status", "--json"], environment);
    const status = execFileSync(invocation.command, invocation.args, {
      env: invocation.environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 256 * 1024,
      timeout: tailscaleCommandTimeoutMs,
    });
    return normalizeHostname(parseTailscaleHostname(normalizeTailscaleStdout(status, invocation)));
  } catch {
    return undefined;
  }
}

function normalizeHostname(value) {
  if (!value) return undefined;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname.replace(/\.+$/, "");
  } catch {
    return value.trim().replace(/\.+$/, "") || undefined;
  }
}

function appendAllowedHost(value, hostname) {
  const hosts = (value ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (!hosts.includes(hostname)) hosts.push(hostname);
  return hosts.join(",");
}

function resolveDevBrowserOrigins({ environment, webHost, webPort, serveProvider, servePort }) {
  const configured = environment.MUXIMOD_ALLOWED_ORIGINS;
  if (configured !== undefined) return normalizeBrowserOrigins(configured.split(","));

  const localHost = browserHost(webHost);
  const origins = [`http://${formatHost(localHost)}:${webPort}`];
  if (serveProvider === "tailscale" && environment.MUXIMO_TAILSCALE_HOSTNAME) {
    const port = servePort ?? 443;
    origins.push(
      port === 443
        ? `https://${environment.MUXIMO_TAILSCALE_HOSTNAME}`
        : `https://${environment.MUXIMO_TAILSCALE_HOSTNAME}:${port}`,
    );
  }
  return normalizeBrowserOrigins(origins);
}

function normalizeBrowserOrigins(values) {
  const origins = new Set();
  for (const value of values) {
    const origin = value.trim();
    if (!origin) continue;
    if (origin === "*") throw new DevRuntimeError("wildcard browser origins are not allowed");
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new DevRuntimeError(`browser origin must use http or https: ${origin}`);
    }
    if (parsed.origin !== origin.replace(/\/$/u, "")) {
      throw new DevRuntimeError(`browser origin must not include a path: ${origin}`);
    }
    origins.add(parsed.origin);
  }
  return [...origins].sort().join(",");
}

function endpoint(host, port, pathname = "/") {
  return `http://${formatHost(host)}:${port}${pathname}`;
}

function browserHost(host) {
  return host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
}

function serviceDefinitions(config) {
  return {
    muximod: {
      name: "muximod",
      host: config.muximodProbeHost,
      port: config.muximodPort,
      environmentVariable: "MUXIMOD_PORT",
      url: endpoint(config.muximodProbeHost, config.muximodPort),
      healthUrl: endpoint(config.muximodProbeHost, config.muximodPort, "/health"),
      command: "bun",
      args: ["--watch", "dev.ts"],
      cwd: resolve(config.repoRoot, "apps/muximod"),
      environment: {
        ...config.baseEnvironment,
        MUXIMOD_HOST: config.muximodHost,
        MUXIMOD_PORT: String(config.muximodPort),
      },
    },
    web: {
      name: "web",
      host: browserHost(config.webHost),
      port: config.webPort,
      environmentVariable: "VITE_DEV_PORT",
      url: endpoint(browserHost(config.webHost), config.webPort),
      command: "node",
      args: ["./node_modules/vite/bin/vite.js"],
      cwd: resolve(config.repoRoot, "apps/web"),
      environment: {
        ...config.baseEnvironment,
        VITE_DEV_HOST: config.webHost,
        VITE_DEV_PORT: String(config.webPort),
      },
    },
  };
}

export async function configureDevServe(config, runCommand = runExternalCommand) {
  if (!config.serveProvider) return undefined;
  if (config.serveProvider !== "tailscale") {
    throw new DevRuntimeError(`unsupported dev serve provider: ${config.serveProvider}`);
  }

  const externalPort = config.servePort ?? 443;
  const binary = config.baseEnvironment.TAILSCALE_BIN ?? "tailscale";
  const args = buildServeArgs({
    localPort: config.webPort,
    externalPort,
  });
  let result;
  try {
    result = await runCommand(binary, args, { env: config.baseEnvironment });
  } catch (error) {
    throw new DevRuntimeError("could not configure Tailscale Serve", { cause: error });
  }

  let hostname = config.baseEnvironment.MUXIMO_TAILSCALE_HOSTNAME;
  if (!hostname) {
    try {
      hostname = parseTailscaleHostname(
        (await runCommand(binary, ["status", "--json"], { env: config.baseEnvironment })).stdout,
      );
    } catch {
      // The Serve route is configured even when the optional display lookup
      // is unavailable. Users can inspect it with `tailscale serve status`.
    }
  }

  return {
    binary,
    args,
    externalPort,
    localPort: config.webPort,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    url: hostname ? buildServeHttpUrl(hostname, externalPort) : undefined,
  };
}

async function runExternalCommand(command, args, options) {
  try {
    const invocation = buildTailscaleInvocation(command, args, options.env);
    const result = await execFileAsync(invocation.command, invocation.args, {
      env: invocation.environment,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      timeout: tailscaleCommandTimeoutMs,
    });
    return { ...result, stdout: normalizeTailscaleStdout(result.stdout, invocation) };
  } catch (error) {
    throw new DevRuntimeError(`could not run ${command}`, { cause: error });
  }
}

export function isPortAvailable(host, port) {
  return isPortListening(host, port).then((listening) => {
    if (listening) return false;
    return canBindPort(host, port);
  });
}

function isPortListening(host, port) {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolveResult(listening);
    };

    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(250, () => finish(false));
  });
}

function canBindPort(host, port) {
  return new Promise((resolveResult, reject) => {
    const server = createServer();
    const onError = (error) => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE") {
        resolveResult(false);
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolveResult(true);
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  });
}

export function parsePortOwners(output) {
  const owners = [];
  let current;

  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("p")) {
      if (current?.pid) owners.push(current);
      current = { pid: line.slice(1) };
      continue;
    }
    if (line.startsWith("c") && current) current.command = line.slice(1);
  }
  if (current?.pid) owners.push(current);

  const unique = new Map();
  for (const owner of owners) unique.set(`${owner.pid}:${owner.command ?? ""}`, owner);
  return [...unique.values()];
}

export function findPortOwners(port, execFileImplementation = execFile) {
  return new Promise((resolveResult) => {
    execFileImplementation(
      "lsof",
      ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
      { encoding: "utf8", maxBuffer: 64 * 1024 },
      (_error, stdout = "") => resolveResult(parsePortOwners(stdout)),
    );
  });
}

export async function inspectPort(host, port, options = {}) {
  const available = await isPortAvailable(host, port);
  if (available) return { available: true, owners: [] };

  const lookupOwners = options.lookupOwners ?? findPortOwners;
  let owners = [];
  try {
    owners = await lookupOwners(port);
  } catch {
    // Port ownership is helpful diagnostics, but an unavailable lsof command
    // must not prevent the health check from producing its recovery advice.
  }
  return { available: false, owners };
}

export function probeHttp(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DEV_CONFIG.probeTimeoutMs;
  const parsed = new URL(url);
  const request = (parsed.protocol === "https:" ? httpsRequest : httpRequest)(parsed, {
    method: "GET",
    headers: { accept: "application/json, text/html;q=0.9" },
  });

  return new Promise((resolveResult, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      request.destroy();
      finish(reject, new Error(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    request.once("error", (error) => finish(reject, error));
    request.once("response", (response) => {
      const chunks = [];
      response.setEncoding("utf8");
      response.on("data", (chunk) => chunks.push(chunk));
      response.once("end", () => {
        finish(resolveResult, {
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body: chunks.join(""),
        });
      });
      response.once("error", (error) => finish(reject, error));
    });
    request.end();
  });
}

export function probeWebSocket(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DEV_CONFIG.probeTimeoutMs;
  const parsed = new URL(url);
  const requestUrl = new URL(parsed);
  requestUrl.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
  const requestImplementation =
    options.request ??
    ((target, requestOptions) => (target.protocol === "https:" ? httpsRequest : httpRequest)(target, requestOptions));
  const request = requestImplementation(requestUrl, {
    method: "GET",
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  });

  return new Promise((resolveResult, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      request.destroy();
      finish(reject, new Error(`WebSocket upgrade timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    request.once("error", (error) => finish(reject, error));
    request.once("upgrade", (response, socket) => {
      const statusCode = response.statusCode ?? 0;
      socket.destroy();
      if (statusCode !== 101) {
        finish(reject, new Error(`WebSocket upgrade returned HTTP ${statusCode}`));
        return;
      }
      finish(resolveResult, { statusCode });
    });
    request.once("response", (response) => {
      response.resume();
      if (response.statusCode === 101) {
        finish(resolveResult, { statusCode: 101 });
        return;
      }
      finish(reject, new Error(`WebSocket route returned HTTP ${response.statusCode ?? 0} instead of 101`));
    });
    request.end();
  });
}

function jsonBody(body) {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function responseSummary(response) {
  const body = typeof response?.body === "string" ? response.body : "";
  const contentType =
    typeof response?.headers?.["content-type"] === "string" ? ` contentType=${response.headers["content-type"]}` : "";
  return `HTTP ${response?.statusCode ?? 0}${contentType} bodyBytes=${Buffer.byteLength(body, "utf8")}`;
}

function readyHealth(detail, evidence = {}) {
  return { ok: true, detail, evidence };
}

function failedHealth(detail, cause) {
  return { ok: false, detail, cause };
}

export async function checkMuximodHealth(config, request = probeHttp) {
  try {
    const response = await request(endpoint(config.muximodProbeHost, config.muximodPort, "/health"), {
      timeoutMs: config.probeTimeoutMs,
    });
    if (response.statusCode !== 200) return failedHealth(`muximod /health returned ${responseSummary(response)}`);

    const body = jsonBody(response.body);
    if (body?.ok !== true || body?.service !== "muximod" || body?.protocolVersion !== 1) {
      return failedHealth(`muximod /health returned an unexpected payload: ${responseSummary(response)}`);
    }
    return readyHealth("HTTP /health is responding with protocol version 1", body);
  } catch (error) {
    return failedHealth(`muximod health probe failed: ${errorMessage(error)}`, error);
  }
}

export async function checkWebHealth(config, requests = {}) {
  try {
    const response = await (requests.http ?? probeHttp)(endpoint(browserHost(config.webHost), config.webPort, "/"), {
      timeoutMs: config.probeTimeoutMs,
    });
    if (response.statusCode !== 200) return failedHealth(`Web UI / returned ${responseSummary(response)}`);
    return readyHealth("Web UI is responding", { statusCode: response.statusCode });
  } catch (error) {
    return failedHealth(`Web UI probe failed: ${errorMessage(error)}`, error);
  }
}

function errorMessage(error) {
  try {
    const value = error instanceof Error ? error.message : String(error);
    return redactDiagnosticText(value);
  } catch {
    return "unknown error";
  }
}

function redactDiagnosticText(value) {
  return value
    .replace(/\bCommand failed:[\s\S]*/gi, "Command failed: [REDACTED]")
    .replace(/(--(?:prompt|token|secret|password|api[-_]?key))(?:=|\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1=[REDACTED]")
    .replace(
      /\b(authorization|cookie|password|passphrase|secret|token|api[-_]?key)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
}

function normalizeOwners(owners) {
  return (owners ?? [])
    .map((owner) => ({ pid: String(owner.pid), command: owner.command ?? "unknown" }))
    .sort((left, right) => `${left.pid}:${left.command}`.localeCompare(`${right.pid}:${right.command}`));
}

function ownersEqual(left, right) {
  const normalizedLeft = normalizeOwners(left);
  const normalizedRight = normalizeOwners(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((owner, index) => {
      const other = normalizedRight[index];
      return owner.pid === other.pid && owner.command === other.command;
    })
  );
}

export function formatPortOwners(owners) {
  const normalized = normalizeOwners(owners);
  if (!normalized.length) return "owner unavailable";
  return normalized.map((owner) => `PID ${owner.pid} (${owner.command})`).join(", ");
}

function recoveryHint(definition) {
  return `lsof -nP -iTCP:${definition.port} -sTCP:LISTEN; stop the owning process or set ${definition.environmentVariable} to another free port`;
}

function portDescription(definition, inspection) {
  if (inspection.available) return `${definition.name} port ${definition.host}:${definition.port} is not listening`;
  return `${definition.name} port ${definition.host}:${definition.port} is owned by ${formatPortOwners(inspection.owners)}`;
}

export function signalProcess(child, signal, platform = process.platform) {
  if (!child?.pid) return false;

  if (platform === "win32" && signal === "SIGKILL") {
    const killer = spawnChild("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    killer.unref?.();
    return true;
  }

  if (platform !== "win32") {
    // Detached children are process-group leaders. Do not fall back to a
    // reused PID if the group has already disappeared.
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  }

  try {
    child.kill(signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolveResult) => setTimeout(resolveResult, milliseconds));
}

function logWith(logger, level, message) {
  const method = logger?.[level] ?? logger?.log ?? console.log;
  method.call(logger ?? console, message);
}

export function createDevSupervisor(options = {}) {
  return new DevSupervisor(options);
}

class DevSupervisor {
  constructor(options) {
    this.config = options.config ?? resolveDevConfig();
    this.verbose = options.verbose ?? this.config.baseEnvironment.MUXIMO_DEV_VERBOSE === "1";
    this.logger = options.logger ?? console;
    this.spawnProcess = options.spawnProcess ?? spawnChild;
    this.inspectPort = options.inspectPort ?? ((host, port) => inspectPort(host, port));
    this.probeHttp = options.probeHttp ?? probeHttp;
    this.configureServe = options.configureServe ?? configureDevServe;
    this.sleep = options.sleep ?? delay;
    this.signalProcess = options.signalProcess ?? signalProcess;
    this.services = serviceDefinitions(this.config);
    this.records = new Map();
    this.state = "created";
    this.failure = undefined;
    this.resolveExit = undefined;
    this.exitPromise = new Promise((resolveResult) => {
      this.resolveExit = resolveResult;
    });
    this.stopPromise = undefined;
  }

  async run() {
    await this.start();
    return this.waitForExit();
  }

  async start() {
    if (this.state !== "created") return this;
    this.state = "starting";
    this.log("info", "[dev] starting local stack (Tailscale Serve is opt-in)");
    this.log("info", `[dev] worktree=${this.config.baseEnvironment.MUXIMO_WORKTREE_ID ?? "unknown"}`);
    this.log(
      "info",
      `[dev] instance=${this.config.baseEnvironment.MUXIMOD_INSTANCE_DIR ?? "default"} tmux socket=${this.config.baseEnvironment.MUXIMOD_TMUX_SOCKET ?? "default"} (shared)`,
    );
    this.log("info", `[dev] muximod target: ${this.services.muximod.url}`);
    this.log("info", `[dev] web target: ${this.services.web.url}`);

    try {
      await this.ensureService("muximod");
      if (this.state !== "starting") return this;
      await this.ensureService("web");
      if (this.state !== "starting") return this;
      const serveStartedAt = Date.now();
      this.log("debug", "[dev] configuring Tailscale Serve");
      const serve = await this.configureServe(this.config);
      this.log("debug", `[dev] Tailscale Serve configuration finished in ${Date.now() - serveStartedAt}ms`);
      if (serve?.stderr) this.log("warn", `[dev] Tailscale Serve: ${serve.stderr.trim()}`);
      this.state = "running";
      this.log("info", `[dev] ready: ${this.services.muximod.healthUrl} is healthy`);
      this.log("info", `[dev] ready: ${this.services.web.url} serves the Web UI`);
      if (serve) {
        this.log(
          "info",
          `[dev] Tailscale Serve: ${serve.url ?? `HTTPS port ${serve.externalPort}`} -> http://127.0.0.1:${serve.localPort}`,
        );
        this.log("info", "[dev] Tailscale Serve is left running; rerun the command to retarget it");
      }
      this.log("info", "[dev] press Ctrl-C to stop processes started by this supervisor");
      return this;
    } catch (error) {
      await this.stop("startup failure", 1);
      throw error;
    }
  }

  waitForExit() {
    return this.exitPromise;
  }

  async stop(reason = "shutdown", exitCode = 0) {
    if (this.state === "stopped") return this.stopPromise;
    if (this.state === "stopping") return this.stopPromise;

    this.state = "stopping";
    const stopStartedAt = Date.now();
    this.log("debug", `[dev] shutdown started reason=${reason}`);
    this.log("info", `[dev] stopping local stack (${reason})`);
    this.stopPromise = (async () => {
      const records = [...this.records.values()];
      const results = await Promise.allSettled(
        records.filter((record) => record.owned).map((record) => this.terminateRecord(record)),
      );
      let finalExitCode = exitCode;
      for (const result of results) {
        if (result.status !== "rejected") continue;
        const error =
          result.reason instanceof DevRuntimeError
            ? result.reason
            : new DevRuntimeError(errorMessage(result.reason), { cause: result.reason });
        this.failure ??= error;
        this.log("error", error.message);
      }
      if (this.failure && finalExitCode === 0) finalExitCode = 1;
      this.state = "stopped";
      this.log("debug", `[dev] shutdown finished exitCode=${finalExitCode} durationMs=${Date.now() - stopStartedAt}`);
      this.resolveExit?.({ exitCode: finalExitCode, reason, failure: this.failure });
    })();
    return this.stopPromise;
  }

  async ensureService(name) {
    if (this.state !== "starting") return undefined;
    const definition = this.services[name];
    this.log("debug", `[dev] checking ${name} on ${definition.host}:${definition.port}`);
    const inspection = await this.inspectPort(definition.host, definition.port);
    this.log(
      "debug",
      `[dev] ${name} port inspection available=${inspection.available} owners=${formatPortOwners(inspection.owners)}`,
    );
    if (inspection.available) {
      this.log("info", `[dev] ${name} port ${definition.host}:${definition.port} is free; starting ${name}`);
      const record = this.launch(definition);
      this.records.set(name, record);
      await this.waitForReady(record);
      return record;
    }

    if (this.config.adoptExistingServices === false) {
      throw this.withPortRecovery(
        definition,
        new DevRuntimeError(`existing ${name} adoption is disabled for the current worktree profile`, {
          service: name,
        }),
        inspection,
      );
    }

    this.log("warn", `[dev] ${portDescription(definition, inspection)}; checking whether it is a healthy ${name}`);
    const record = this.createAdoptedRecord(definition, inspection);
    this.records.set(name, record);
    try {
      await this.waitForReady(record);
    } catch (error) {
      throw this.withPortRecovery(definition, error, inspection);
    }
    this.log(
      "info",
      `[dev] reusing healthy ${name} on ${definition.host}:${definition.port} (${formatPortOwners(record.ownerSnapshot)})`,
    );
    return record;
  }

  createAdoptedRecord(definition, inspection) {
    return {
      name: definition.name,
      definition,
      child: undefined,
      owned: false,
      exited: false,
      intentionalStop: false,
      ownerSnapshot: inspection.owners?.length ? normalizeOwners(inspection.owners) : undefined,
      exitPromise: Promise.resolve(),
    };
  }

  launch(definition) {
    this.log(
      "debug",
      `[dev] spawning ${definition.name}: executable=${definition.command} argumentCount=${definition.args.length}`,
    );
    const child = this.spawnProcess(definition.command, definition.args, {
      cwd: definition.cwd,
      env: definition.environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    const record = {
      name: definition.name,
      definition,
      child,
      owned: true,
      exited: false,
      intentionalStop: false,
      ownerSnapshot: undefined,
      startError: undefined,
      exitCode: undefined,
      exitSignal: undefined,
    };
    record.exitPromise = new Promise((resolveResult) => {
      record.resolveExit = resolveResult;
    });

    child.once("error", (error) => {
      record.startError = error;
      this.log("error", `[dev] ${definition.name} failed to start: ${errorMessage(error)}`);
    });
    child.once("exit", (code, signal) => {
      record.exited = true;
      record.exitCode = code;
      record.exitSignal = signal;
      record.resolveExit?.();
      this.log(
        "debug",
        `[dev] ${definition.name} exited code=${code ?? "null"} signal=${signal ?? "none"} intentional=${record.intentionalStop}`,
      );
      if (this.state === "running" && !record.intentionalStop) {
        void this.handleUnexpectedExit(record, code, signal);
      }
    });
    return record;
  }

  async waitForReady(record) {
    const deadline = Date.now() + this.config.readyTimeoutMs;
    let lastHealth = failedHealth("no health response yet");
    let lastInspection = { available: false, owners: record.ownerSnapshot ?? [] };
    let attempt = 0;

    while (Date.now() <= deadline) {
      attempt += 1;
      if (record.startError) {
        throw new DevRuntimeError(`${record.name} failed to start: ${errorMessage(record.startError)}`, {
          service: record.name,
          cause: record.startError,
        });
      }
      if (record.exited) {
        throw new DevRuntimeError(
          `${record.name} exited before becoming ready (exit ${record.exitCode ?? "unknown"}${record.exitSignal ? `, ${record.exitSignal}` : ""})`,
          {
            service: record.name,
          },
        );
      }

      lastInspection = await this.inspectPort(record.definition.host, record.definition.port);
      if (lastInspection.available) {
        lastHealth = failedHealth(
          `${record.name} is not listening on ${record.definition.host}:${record.definition.port}`,
        );
      } else {
        if (record.ownerSnapshot && !ownersEqual(record.ownerSnapshot, lastInspection.owners)) {
          throw this.replacedProcessError(record.definition, record.ownerSnapshot, lastInspection.owners);
        }
        lastHealth = await this.checkHealth(record.definition);
        this.log(
          "debug",
          `[dev] ${record.name} readiness probe attempt=${attempt} healthy=${lastHealth.ok} detail=${lastHealth.detail}`,
        );
        if (lastHealth.ok) {
          if (lastInspection.owners?.length) record.ownerSnapshot = normalizeOwners(lastInspection.owners);
          return lastHealth;
        }
      }

      if (Date.now() >= deadline) break;
      await this.sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    }

    throw this.readinessError(record.definition, lastHealth, lastInspection);
  }

  async checkHealth(definition) {
    if (definition.name === "muximod") return checkMuximodHealth(this.config, this.probeHttp);
    return checkWebHealth(this.config, { http: this.probeHttp });
  }

  async handleUnexpectedExit(record, code, signal) {
    if (this.state !== "running" || record.intentionalStop) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
    this.failure = new DevRuntimeError(
      `[dev] ${record.name} stopped unexpectedly with ${reason}; automatic restart is disabled`,
      { service: record.name },
    );
    this.log("error", this.failure.message);
    await this.stop("runtime failure", 1);
  }

  async terminateRecord(record) {
    if (!record?.owned || record.intentionalStop) return;
    const startedAt = Date.now();
    this.log("debug", `[dev] stopping ${record.name} pid=${record.child?.pid ?? "unknown"}`);
    record.intentionalStop = true;
    try {
      this.signalProcess(record.child, "SIGTERM");
    } catch (error) {
      this.log("warn", `[dev] could not send SIGTERM to ${record.name}: ${errorMessage(error)}`);
    }
    await this.waitForRecordExit(record, this.config.shutdownTimeoutMs);
    let portStatus = { released: false, owners: [] };
    try {
      portStatus = await this.waitForPortToFree(record.definition);
    } catch (error) {
      this.log("warn", `[dev] could not verify that ${record.name} released its port: ${errorMessage(error)}`);
    }
    if (!record.exited || !portStatus.released) {
      try {
        this.signalProcess(record.child, "SIGKILL");
      } catch (error) {
        this.log("warn", `[dev] could not send SIGKILL to ${record.name}: ${errorMessage(error)}`);
      }
      await this.waitForRecordExit(record, this.config.shutdownTimeoutMs);
      if (!portStatus.released) {
        try {
          portStatus = await this.waitForPortToFree(record.definition);
        } catch (error) {
          this.log(
            "warn",
            `[dev] could not verify that ${record.name} released its port after SIGKILL: ${errorMessage(error)}`,
          );
        }
      }
    }
    const replacementListener = Boolean(
      !portStatus.released &&
        record.ownerSnapshot?.length &&
        portStatus.owners?.length &&
        !ownersEqual(record.ownerSnapshot, portStatus.owners),
    );
    if (!record.exited || (!portStatus.released && !replacementListener)) {
      const error = new DevRuntimeError(
        `[dev] ${record.name} may still be running (PID ${record.child?.pid ?? "unknown"}); inspect its port with ${recoveryHint(record.definition)}`,
        { service: record.name },
      );
      this.failure ??= error;
      this.log("error", error.message);
    }
    this.log(
      "debug",
      `[dev] stopped ${record.name} exited=${record.exited} portReleased=${portStatus.released} durationMs=${Date.now() - startedAt}`,
    );
  }

  async waitForRecordExit(record, timeoutMs) {
    if (record.exited || !record.child?.pid) return;
    await Promise.race([record.exitPromise, delay(timeoutMs)]);
  }

  async waitForPortToFree(definition) {
    const deadline = Date.now() + this.config.shutdownTimeoutMs;
    let lastInspection = { available: false, owners: [] };
    while (Date.now() <= deadline) {
      lastInspection = await this.inspectPort(definition.host, definition.port);
      if (lastInspection.available) return { released: true, owners: [] };
      if (Date.now() >= deadline) break;
      await this.sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    this.log(
      "warn",
      `[dev] ${definition.name} port ${definition.host}:${definition.port} is still occupied by ${formatPortOwners(lastInspection.owners)}`,
    );
    return { released: false, owners: lastInspection.owners ?? [] };
  }

  withPortRecovery(definition, error, inspection) {
    if (error instanceof DevRuntimeError && error.message.includes("lsof")) return error;
    const ownerText = inspection ? ` Current owner: ${formatPortOwners(inspection.owners)}.` : "";
    return new DevRuntimeError(
      `[dev] ${definition.name} is not ready: ${errorMessage(error)}${ownerText} Recovery: ${recoveryHint(definition)}.`,
      { service: definition.name, cause: error },
    );
  }

  replacedProcessError(definition, expectedOwners, actualOwners) {
    return new DevRuntimeError(
      `[dev] ${definition.name} on ${definition.host}:${definition.port} was replaced: expected ${formatPortOwners(expectedOwners)}, found ${formatPortOwners(actualOwners)}. I will not kill the replacement. Recovery: ${recoveryHint(definition)}.`,
      { service: definition.name },
    );
  }

  readinessError(definition, health, inspection) {
    return new DevRuntimeError(
      `[dev] ${definition.name} did not become healthy on ${definition.host}:${definition.port} within ${this.config.readyTimeoutMs}ms: ${health.detail}. ${portDescription(definition, inspection)}. Recovery: ${recoveryHint(definition)}.`,
      { service: definition.name, cause: health.cause },
    );
  }

  log(level, message) {
    if (level === "debug" && !this.verbose) return;
    logWith(this.logger, level, message);
  }
}

export async function main(options = {}) {
  let supervisor;
  try {
    supervisor = createDevSupervisor(options);
  } catch (error) {
    console.error(formatDevError(error));
    process.exitCode = 1;
    return { exitCode: 1, failure: error };
  }
  const onSignal = (signal) => {
    void supervisor.stop(signal, 0);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const result = await supervisor.run();
    process.exitCode = result.exitCode;
    return result;
  } catch (error) {
    console.error(formatDevError(error));
    await supervisor.stop("startup failure", 1);
    process.exitCode = 1;
    return { exitCode: 1, failure: error };
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  void main().catch((error) => {
    console.error(formatDevError(error));
    process.exitCode = 1;
  });
}

function formatDevError(error) {
  if (process.env.MUXIMO_DEV_VERBOSE === "1" && error instanceof Error && error.stack)
    return redactDiagnosticText(error.stack);
  return `[dev] ${errorMessage(error)}`;
}
