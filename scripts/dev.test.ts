import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assertion,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
} from "@muximo/test-support";
import { protocolVersion } from "../packages/contract/src/protocol.ts";
import {
  checkMuximodHealth,
  checkWebHealth,
  configureDevServe,
  createDevSupervisor,
  DevRuntimeError,
  formatPortOwners,
  parsePortOwners,
  probeWebSocket,
  resolveDevConfig,
} from "./dev.mjs";

const succeeds = (name: string, check: (value: any) => void): Assertion<any, any> => ({
  name,
  check: (_ctx, outcome) => {
    assert.equal(outcome.ok, true);
    check(outcome.value);
  },
});
const observes = (name: string, check: (context: any) => void): Assertion<any, any> => ({
  name,
  check: (ctx) => check(ctx),
});
const fails = (name: string, check: (error: any) => void): Assertion<any, any> => ({
  name,
  allowsOutcomeError: true,
  check: (_ctx, outcome) => {
    assert.equal(outcome.ok, false);
    check(outcome.error);
  },
});

type PureInput =
  | { kind: "resolve-profile" }
  | { kind: "parse-owners" }
  | { kind: "configure-serve" }
  | { kind: "allowed-host" }
  | { kind: "health" }
  | { kind: "invalid-host" }
  | { kind: "muximod-health" }
  | { kind: "probe-websocket" };
type PureFixture = ReturnType<typeof createPureFixture>;
type PureContext = { value: unknown };

const pureCases = [
  {
    name: "assigns a worktree profile and refuses to adopt another runtime",
    input: { kind: "resolve-profile" },
    assert: [
      succeeds("uses isolated worktree settings", (config) => {
        assert.equal(config.adoptExistingServices, false);
        assert.match(config.baseEnvironment.MUXIMO_WORKTREE_ID, /^[0-9a-f]{16}$/);
        assert.match(config.baseEnvironment.MUXIMOD_INSTANCE_DIR, /worktrees\/[^/]+$/);
        assert.equal(config.baseEnvironment.MUXIMOD_TMUX_SOCKET, undefined);
      }),
    ],
  },
  {
    name: "parses lsof process-field output and formats actionable owners",
    input: { kind: "parse-owners" },
    assert: [
      succeeds("deduplicates process owners", (value) => {
        assert.deepEqual(value.owners, [
          { pid: "123", command: "node" },
          { pid: "456", command: "vite" },
        ]);
        assert.equal(value.formatted, "PID 123 (node), PID 456 (vite)");
      }),
    ],
  },
  {
    name: "upserts the fixed local Tailscale Serve port after Web is ready",
    input: { kind: "configure-serve" },
    assert: [
      succeeds("configures the expected Serve endpoint", (value) => {
        assert.deepEqual(value.calls, [
          { command: "tailscale-test", args: ["serve", "--bg", "--https=443", "--yes", "http://127.0.0.1:15227"] },
        ]);
        assert.equal(value.result.url, "https://local-host.tailnet.ts.net/");
        assert.equal(value.result.localPort, 15_227);
      }),
    ],
  },
  {
    name: "allows the Tailscale hostname in the Vite dev server",
    input: { kind: "allowed-host" },
    assert: [
      succeeds("adds the Tailscale hostname to Vite", (config) => {
        assert.equal(config.baseEnvironment.MUXIMO_TAILSCALE_HOSTNAME, "local-host.tailnet.ts.net");
        assert.equal(config.baseEnvironment.VITE_ALLOWED_HOSTS, "local-host.tailnet.ts.net");
      }),
    ],
  },
  {
    name: "rejects an invalid configured Tailscale hostname",
    input: { kind: "invalid-host" },
    assert: [
      fails("reports the invalid hostname", (error) => {
        assert.equal(error.name, "DevRuntimeError");
        assert.match(error.message, /invalid Tailscale hostname/);
      }),
    ],
  },
  {
    name: "uses the Web root for Web readiness",
    input: { kind: "health" },
    assert: [
      succeeds("probes only the Web UI", (value) => {
        assert.equal(value.result.ok, true);
        assert.deepEqual(value.httpRequests, ["/"]);
        assert.deepEqual(value.websocketRequests, []);
      }),
    ],
  },
  {
    name: "does not include health response bodies in readiness diagnostics",
    input: { kind: "muximod-health" },
    assert: [
      succeeds("redacts the health response body", (value) => {
        assert.equal(value.ok, false);
        assert.match(value.detail, /HTTP 500/);
        assert.match(value.detail, /bodyBytes=/);
        assert.doesNotMatch(value.detail, /top-secret|do-not-log/);
      }),
    ],
  },
  {
    name: "probes WebSocket URLs through HTTP and accepts a 101 response event",
    input: { kind: "probe-websocket" },
    assert: [
      succeeds("converts the WebSocket URL to HTTP", (value) => {
        assert.equal(value.requestedUrl.protocol, "http:");
        assert.equal(value.result.statusCode, 101);
      }),
    ],
  },
] satisfies readonly OperationCase<"default", PureInput, unknown, PureContext>[];

const pureTable = {
  defaultFixture: () => {
    const fixture = createPureFixture();
    return { fixture, cleanup: () => rmSync(fixture.stateRoot, { recursive: true, force: true }) };
  },
  cases: pureCases,
  execute: async (fixture, input) => {
    if (input.kind === "resolve-profile") {
      return resolveDevConfig({ MUXIMO_DEV_STATE_ROOT: fixture.stateRoot }, process.cwd());
    }
    if (input.kind === "parse-owners") {
      const owners = parsePortOwners("p123\ncnode\np123\ncnode\np456\ncvite\n");
      return { owners, formatted: formatPortOwners(owners) };
    }
    if (input.kind === "configure-serve") {
      const calls = [];
      const result = await configureDevServe(
        {
          serveProvider: "tailscale",
          servePort: 443,
          webPort: 15_227,
          baseEnvironment: { TAILSCALE_BIN: "tailscale-test", MUXIMO_TAILSCALE_HOSTNAME: "local-host.tailnet.ts.net" },
        },
        async (command, args) => {
          calls.push({ command, args });
          return { stdout: "", stderr: "" };
        },
      );
      return { calls, result };
    }
    if (input.kind === "allowed-host") {
      return resolveDevConfig(
        {
          MUXIMO_DEV_STATE_ROOT: fixture.stateRoot,
          MUXIMO_DEV_SERVE_PROVIDER: "tailscale",
          MUXIMO_TAILSCALE_HOSTNAME: "local-host.tailnet.ts.net.",
        },
        process.cwd(),
      );
    }
    if (input.kind === "invalid-host") {
      return resolveDevConfig(
        {
          MUXIMO_DEV_STATE_ROOT: fixture.stateRoot,
          MUXIMO_DEV_SERVE_PROVIDER: "tailscale",
          MUXIMO_TAILSCALE_HOSTNAME: "https://[invalid",
        },
        process.cwd(),
      );
    }
    if (input.kind === "health") {
      fixture.healthRuntime.ports.set("muximod", { healthy: true, owners: [{ pid: "1", command: "muximod" }] });
      fixture.healthRuntime.ports.set("web", { healthy: true, owners: [{ pid: "2", command: "vite" }] });
      const result = await checkWebHealth(fixture.healthRuntime.supervisor.config, {
        http: async (url) => {
          const parsed = new URL(url);
          fixture.healthRuntime.httpRequests.push(parsed.pathname);
          return parsed.pathname === "/"
            ? { statusCode: 200, body: "<!doctype html><html><body>dev</body></html>" }
            : { statusCode: 503, body: "service unavailable" };
        },
      });
      return {
        result,
        httpRequests: fixture.healthRuntime.httpRequests,
        websocketRequests: fixture.healthRuntime.websocketRequests,
      };
    }
    if (input.kind === "muximod-health") {
      return checkMuximodHealth(fixture.healthRuntime.supervisor.config, async () => ({
        statusCode: 500,
        headers: { "content-type": "text/plain" },
        body: "top-secret token=do-not-log",
      }));
    }
    let requestedUrl: URL | undefined;
    const result = await probeWebSocket("ws://127.0.0.1:14317/terminal", {
      request: (url) => {
        requestedUrl = url;
        const request = new EventEmitter();
        request.destroy = () => {};
        request.end = () => queueMicrotask(() => request.emit("response", { statusCode: 101, resume: () => {} }));
        return request;
      },
    });
    return { requestedUrl, result };
  },
  observe: (_fixture, outcome) => ({ value: outcome.ok ? outcome.value : undefined }),
} satisfies OperationTable<PureFixture, "default", PureInput, unknown, PureContext>;

type SupervisorKey = "default" | "healthy" | "adoption-disabled" | "foreign-conflict";
type SupervisorStep =
  | { type: "start" }
  | { type: "stop"; reason: string; exitCode: number }
  | { type: "web-exit" }
  | { type: "replace-web" }
  | { type: "wait" };
type SupervisorFixture = { runtime: ReturnType<typeof createFakeRuntime> };
type SupervisorContext = {
  state: string;
  spawnNames: string[];
  spawnCommands: string[];
  spawnArgs: string[][];
  spawnCwds: string[];
  detached: boolean;
  shell: boolean;
  websocketRequests: string[];
  readyLog: boolean;
  signals: string[];
  portCount: number;
  spawnCount: number;
  signalCount: number;
  reusedMuximod: boolean;
  reusedWeb: boolean;
  exitCode: number | undefined;
  restartDisabled: boolean;
  muximodTerminated: boolean;
  webSignaled: boolean;
  webOwners: unknown;
  replacementLog: boolean;
  error: unknown;
};

const supervisorCases = [
  {
    name: "starts the two services, reports readiness, and kills their process groups",
    fixture: "default",
    steps: [{ type: "start" }, { type: "stop", reason: "test", exitCode: 0 }],
    assert: [
      observes("starts both services", (ctx) => {
        assert.equal(ctx.state, "stopped");
        assert.deepEqual(ctx.spawnNames, ["muximod", "web"]);
        assert.deepEqual(ctx.spawnCommands, ["bun", "node"]);
        assert.deepEqual(ctx.spawnArgs, [["--watch", "dev.ts"], ["./node_modules/vite/bin/vite.js"]]);
        assert.deepEqual(ctx.spawnCwds, ["/repo/apps/muximod", "/repo/apps/web"]);
        assert.equal(ctx.detached, true);
        assert.equal(ctx.shell, false);
        assert.deepEqual(ctx.websocketRequests, []);
        assert.equal(ctx.readyLog, true);
        assert.deepEqual(ctx.signals, ["muximod:SIGTERM", "web:SIGTERM"]);
        assert.equal(ctx.portCount, 0);
      }),
    ],
  },
  {
    name: "reuses healthy listeners without claiming or killing them",
    fixture: "healthy",
    steps: [{ type: "start" }, { type: "stop", reason: "test", exitCode: 0 }],
    assert: [
      observes("reuses existing services", (ctx) => {
        assert.equal(ctx.spawnCount, 0);
        assert.equal(ctx.reusedMuximod, true);
        assert.equal(ctx.reusedWeb, true);
        assert.equal(ctx.signalCount, 0);
      }),
    ],
  },
  {
    name: "does not adopt a healthy listener for a worktree profile",
    fixture: "adoption-disabled",
    steps: [{ type: "start" }],
    assert: [
      fails("reports adoption disabled", (error) => {
        assert.equal(error instanceof DevRuntimeError, true);
        assert.match(error.message, /adoption is disabled/);
        assert.match(error.message, /PID 401 \(other-worktree-muximod\)/);
      }),
      observes("does not spawn a replacement", (ctx) => assert.equal(ctx.spawnCount, 0)),
    ],
  },
  {
    name: "fails a foreign port conflict with the owner and recovery command",
    fixture: "foreign-conflict",
    steps: [{ type: "start" }],
    assert: [
      fails("reports the foreign owner", (error) => {
        assert.equal(error instanceof DevRuntimeError, true);
        assert.match(error.message, /PID 301 \(stale-muximod\)/);
        assert.match(error.message, /MUXIMOD_PORT/);
        assert.match(error.message, /lsof -nP/);
      }),
      observes("does not spawn a replacement", (ctx) => assert.equal(ctx.spawnCount, 0)),
    ],
  },
  {
    name: "stops the stack when an owned service exits instead of restarting it",
    fixture: "default",
    steps: [{ type: "start" }, { type: "web-exit" }, { type: "wait" }],
    assert: [
      observes("stops after a child exits", (ctx) => {
        assert.deepEqual(ctx.spawnNames, ["muximod", "web"]);
        assert.equal(ctx.exitCode, 1);
        assert.equal(ctx.state, "stopped");
        assert.equal(ctx.restartDisabled, true);
        assert.equal(ctx.muximodTerminated, true);
      }),
    ],
  },
  {
    name: "stops its own process group without killing a replacement listener",
    fixture: "default",
    steps: [
      { type: "start" },
      { type: "replace-web" },
      { type: "stop", reason: "test", exitCode: 0 },
      { type: "wait" },
    ],
    assert: [
      observes("preserves the replacement listener", (ctx) => {
        assert.equal(ctx.exitCode, 0);
        assert.equal(ctx.state, "stopped");
        assert.equal(ctx.webSignaled, true);
        assert.deepEqual(ctx.webOwners, [{ pid: "999", command: "replacement" }]);
        assert.equal(ctx.replacementLog, true);
      }),
    ],
  },
] satisfies readonly ScenarioCase<SupervisorKey, SupervisorStep, { exitCode: number }, SupervisorContext>[];

const supervisorFactories = {
  default: () => ({ fixture: { runtime: createFakeRuntime() }, cleanup: async () => {} }),
  healthy: () => {
    const runtime = createFakeRuntime();
    runtime.ports.set("muximod", { healthy: true, owners: [{ pid: "201", command: "muximod" }] });
    runtime.ports.set("web", { healthy: true, owners: [{ pid: "202", command: "vite" }] });
    return { fixture: { runtime }, cleanup: async () => {} };
  },
  "adoption-disabled": () => {
    const runtime = createFakeRuntime({ config: { adoptExistingServices: false, readyTimeoutMs: 5 } });
    runtime.ports.set("muximod", { healthy: true, owners: [{ pid: "401", command: "other-worktree-muximod" }] });
    return { fixture: { runtime }, cleanup: async () => {} };
  },
  "foreign-conflict": () => {
    const runtime = createFakeRuntime({ config: { readyTimeoutMs: 5 } });
    runtime.ports.set("muximod", { healthy: false, owners: [{ pid: "301", command: "stale-muximod" }] });
    return { fixture: { runtime }, cleanup: async () => {} };
  },
};

const supervisorTable = {
  defaultFixture: supervisorFactories.default,
  fixtures: supervisorFactories,
  cases: supervisorCases,
  execute: async (fixture, steps) => {
    let exitResult: { exitCode: number | null; signal: string | null } | undefined;
    for (const step of steps) {
      if (step.type === "start") await fixture.runtime.supervisor.start();
      if (step.type === "stop") await fixture.runtime.supervisor.stop(step.reason, step.exitCode);
      if (step.type === "web-exit") {
        const webCall = fixture.runtime.spawnCalls.find((call) => call.name === "web");
        const webChild = fixture.runtime.children.find((child) => child.pid === webCall.pid);
        fixture.runtime.ports.delete("web");
        webChild.emit("exit", 1, null);
      }
      if (step.type === "replace-web")
        fixture.runtime.ports.set("web", { healthy: true, owners: [{ pid: "999", command: "replacement" }] });
      if (step.type === "wait") exitResult = await fixture.runtime.supervisor.waitForExit();
    }
    return { exitCode: exitResult?.exitCode ?? 0 };
  },
  observe: (fixture, outcome) => {
    const runtime = fixture.runtime;
    return {
      state: runtime.supervisor.state,
      spawnNames: runtime.spawnCalls.map((call) => call.name),
      spawnCommands: runtime.spawnCalls.map((call) => call.command),
      spawnArgs: runtime.spawnCalls.map((call) => call.args),
      spawnCwds: runtime.spawnCalls.map((call) => call.options.cwd),
      detached: runtime.spawnCalls.every((call) => call.options.detached === true),
      shell: runtime.spawnCalls.some((call) => call.options.shell === true),
      websocketRequests: runtime.websocketRequests,
      readyLog: runtime.logs.some(({ message }) => message.includes("[dev] ready:")),
      signals: runtime.signals.map(({ name, signal }) => `${name}:${signal}`),
      portCount: runtime.ports.size,
      spawnCount: runtime.spawnCalls.length,
      signalCount: runtime.signals.length,
      reusedMuximod: runtime.logs.some(({ message }) => message.includes("reusing healthy muximod")),
      reusedWeb: runtime.logs.some(({ message }) => message.includes("reusing healthy web")),
      exitCode: outcome.ok ? outcome.value.exitCode : undefined,
      restartDisabled: runtime.logs.some(({ message }) => message.includes("automatic restart is disabled")),
      muximodTerminated: runtime.signals.some(({ name, signal }) => name === "muximod" && signal === "SIGTERM"),
      webSignaled: runtime.signals.some(
        ({ pid }) => pid === runtime.spawnCalls.find((call) => call.name === "web")?.pid,
      ),
      webOwners: runtime.ports.get("web")?.owners,
      replacementLog: runtime.logs.some(({ message }) => message.includes("still occupied by PID 999 (replacement)")),
      error: outcome.ok ? null : outcome.error,
    };
  },
} satisfies ScenarioTable<SupervisorFixture, SupervisorKey, SupervisorStep, { exitCode: number }, SupervisorContext>;

describe("dev orchestration diagnostics", () => {
  runOperationTable(it, pureTable);
  runScenarioTable(it, supervisorTable);
});

function createPureFixture() {
  const stateRoot = mkdtempSync(join(tmpdir(), "muximo-dev-test-"));
  return { stateRoot, healthRuntime: createFakeRuntime() };
}

function createFakeRuntime(overrides = {}) {
  const config = {
    muximodHost: "127.0.0.1",
    muximodProbeHost: "127.0.0.1",
    muximodPort: 14_317,
    webHost: "127.0.0.1",
    webPort: 15_227,
    repoRoot: "/repo",
    baseEnvironment: { PATH: "/test/bin" },
    readyTimeoutMs: 25,
    shutdownTimeoutMs: 25,
    probeTimeoutMs: 5,
  };
  const ports = new Map();
  const children = [];
  const spawnCalls = [];
  const signals = [];
  const httpRequests = [];
  const websocketRequests = [];
  const logs = [];
  let nextPid = 100;
  const serviceForPort = (port) => (port === config.muximodPort ? "muximod" : "web");
  const healthy = (name) => ports.get(name)?.healthy === true;
  const owners = (name) => ports.get(name)?.owners ?? [];
  const inspectPort = async (_host, port) => {
    const name = serviceForPort(port);
    return ports.has(name) ? { available: false, owners: owners(name) } : { available: true, owners: [] };
  };
  const probeHttp = async (url) => {
    const parsed = new URL(url);
    httpRequests.push(parsed.pathname);
    const name = parsed.port === String(config.muximodPort) ? "muximod" : "web";
    if (parsed.pathname === "/health" && healthy("muximod"))
      return { statusCode: 200, body: JSON.stringify({ ok: true, service: "muximod", protocolVersion }) };
    if (name === "web" && parsed.pathname === "/" && healthy("web"))
      return { statusCode: 200, body: "<!doctype html><html><body>dev</body></html>" };
    if (name === "web" && parsed.pathname === "/api/capabilities" && healthy("web") && healthy("muximod"))
      return { statusCode: 200, body: JSON.stringify({ protocolVersion, features: { terminalWebSocket: true } }) };
    return { statusCode: 503, body: "service unavailable" };
  };
  const probeWebSocket = async (url) => {
    websocketRequests.push(new URL(url).pathname);
    if (!healthy("web") || !healthy("muximod")) throw new Error("WebSocket route unavailable");
    return { statusCode: 101 };
  };
  const spawnProcess = (command, args, options) => {
    const name = command === "bun" ? "muximod" : "web";
    const pid = nextPid++;
    const child = new EventEmitter();
    child.pid = pid;
    child.kill = (signal) => {
      signals.push({ name, pid, signal });
      const current = ports.get(name);
      if (current?.owners.some((owner) => owner.pid === String(pid))) ports.delete(name);
      queueMicrotask(() => child.emit("exit", null, signal));
      return true;
    };
    ports.set(name, { healthy: true, owners: [{ pid: String(pid), command: `${name}-fake` }] });
    children.push(child);
    spawnCalls.push({ command, args, options, name, pid });
    return child;
  };
  const logger = {
    info: (message) => logs.push({ level: "info", message }),
    warn: (message) => logs.push({ level: "warn", message }),
    error: (message) => logs.push({ level: "error", message }),
    log: (message) => logs.push({ level: "log", message }),
  };
  const supervisor = createDevSupervisor({
    config: { ...config, ...overrides.config },
    inspectPort,
    probeHttp,
    probeWebSocket,
    spawnProcess,
    signalProcess: (child, signal) => child.kill(signal),
    sleep: async () => {},
    logger,
  });
  return { config, ports, children, spawnCalls, signals, httpRequests, websocketRequests, logs, supervisor };
}
