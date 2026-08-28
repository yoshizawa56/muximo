import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  type DaemonEnsureResult,
  DaemonHealthError,
  type DaemonOptions,
  type DaemonRestartResult,
  type DaemonRuntimePort,
  type DaemonStartResult,
  type DaemonStatusResult,
  type DaemonStopResult,
  EnsureDaemon,
  RestartDaemon,
  StartDaemon,
  StatusDaemon,
  StopDaemon,
} from "../../index.js";

type LifecycleResult =
  | DaemonEnsureResult
  | DaemonRestartResult
  | DaemonStartResult
  | DaemonStatusResult
  | DaemonStopResult;
type LifecycleInput =
  | { operation: "ensure" }
  | { operation: "restart"; refreshServers: boolean }
  | { operation: "start-background" }
  | { operation: "start-foreground" }
  | { operation: "status" }
  | { operation: "stop" };

type LifecycleFixture = {
  healthy: boolean;
  healthyAfterSpawn: boolean;
  healthyAfterStop: boolean;
  alive: boolean;
  record?: { pid: number; host: string; port: number; startedAt: string };
  now: number;
  sleeps: number[];
  spawnCount: number;
  signalCount: number;
  terminateCount: number;
  removePidCount: number;
  markerWrites: boolean[];
  service: {
    ensure: EnsureDaemon;
    restart: RestartDaemon;
    start: StartDaemon;
    status: StatusDaemon;
    stop: StopDaemon;
  };
};

type LifecycleContext = {
  outcomeState: string | undefined;
  outcomeKind: string | undefined;
  errorReason: string | undefined;
  spawnCount: number;
  signalCount: number;
  terminateCount: number;
  removePidCount: number;
  markerWrites: readonly boolean[];
  sleeps: readonly number[];
};

const options: DaemonOptions = {
  host: "127.0.0.1",
  port: 4317,
  pidFile: "/tmp/muximod-daemon.test.pid",
  logFile: "/tmp/muximod-daemon.test.log",
};

const cases = [
  {
    name: "ensure returns already-running without spawning",
    fixture: "running",
    input: { operation: "ensure" },
    assert: [
      hasObserved<LifecycleContext, LifecycleResult>("outcomeState", "already-running"),
      hasObserved<LifecycleContext, LifecycleResult>("spawnCount", 0),
    ],
  },
  {
    name: "ensure spawns and waits through injected timing when the service becomes healthy",
    fixture: "startable",
    input: { operation: "ensure" },
    assert: [
      hasObserved<LifecycleContext, LifecycleResult>("outcomeState", "started"),
      hasObserved<LifecycleContext, LifecycleResult>("spawnCount", 1),
      hasObserved<LifecycleContext, LifecycleResult>("sleeps", []),
    ],
  },
  {
    name: "ensure terminates a timed-out child and reports a typed health reason",
    fixture: "timeout",
    input: { operation: "ensure" },
    assert: [
      hasError<LifecycleContext, LifecycleResult>({ name: "DaemonHealthError", message: "startup_timeout" }),
      hasObserved<LifecycleContext, LifecycleResult>("errorReason", "startup_timeout"),
      hasObserved<LifecycleContext, LifecycleResult>("spawnCount", 1),
      hasObserved<LifecycleContext, LifecycleResult>("terminateCount", 1),
      hasObserved<LifecycleContext, LifecycleResult>("sleeps", [50, 50]),
    ],
  },
  {
    name: "status reports a healthy process and its pid",
    fixture: "running",
    input: { operation: "status" },
    assert: [
      hasObserved<LifecycleContext, LifecycleResult>("outcomeState", "running"),
      hasObserved<LifecycleContext, LifecycleResult>("removePidCount", 0),
    ],
  },
  {
    name: "status removes a stale pid record",
    fixture: "stale",
    input: { operation: "status" },
    assert: [
      hasObserved<LifecycleContext, LifecycleResult>("outcomeState", "stopped"),
      hasObserved<LifecycleContext, LifecycleResult>("removePidCount", 1),
    ],
  },
  {
    name: "start foreground returns the process result without lifecycle presentation",
    fixture: "foreground",
    input: { operation: "start-foreground" },
    assert: [
      hasObserved<LifecycleContext, LifecycleResult>("outcomeKind", "foreground"),
      hasObserved<LifecycleContext, LifecycleResult>("spawnCount", 0),
    ],
  },
  {
    name: "start background delegates to ensure",
    fixture: "startable",
    input: { operation: "start-background" },
    assert: [
      hasObserved<LifecycleContext, LifecycleResult>("outcomeKind", "background"),
      hasObserved<LifecycleContext, LifecycleResult>("outcomeState", "started"),
      hasObserved<LifecycleContext, LifecycleResult>("spawnCount", 1),
    ],
  },
  {
    name: "stop signals a healthy daemon and removes its pid record",
    fixture: "running",
    input: { operation: "stop" },
    assert: [
      hasObserved<LifecycleContext, LifecycleResult>("outcomeState", "stopped"),
      hasObserved<LifecycleContext, LifecycleResult>("signalCount", 1),
      hasObserved<LifecycleContext, LifecycleResult>("removePidCount", 1),
    ],
  },
  {
    name: "stop reports a typed timeout when the process remains alive",
    fixture: "stop-timeout",
    input: { operation: "stop" },
    assert: [
      hasError<LifecycleContext, LifecycleResult>({ name: "DaemonHealthError", message: "stop_timeout" }),
      hasObserved<LifecycleContext, LifecycleResult>("errorReason", "stop_timeout"),
      hasObserved<LifecycleContext, LifecycleResult>("signalCount", 1),
      hasObserved<LifecycleContext, LifecycleResult>("sleeps", [50, 50]),
    ],
  },
  {
    name: "restart records intent and starts a replacement when the service manager does not recover it",
    fixture: "restartable",
    input: { operation: "restart", refreshServers: true },
    assert: [
      hasObserved<LifecycleContext, LifecycleResult>("outcomeState", "restarted"),
      hasObserved<LifecycleContext, LifecycleResult>("markerWrites", [true]),
      hasObserved<LifecycleContext, LifecycleResult>("spawnCount", 1),
    ],
  },
  {
    name: "restart recognizes a service-manager replacement without spawning twice",
    fixture: "service-manager",
    input: { operation: "restart", refreshServers: false },
    assert: [
      hasObserved<LifecycleContext, LifecycleResult>("outcomeState", "restarted-by-service-manager"),
      hasObserved<LifecycleContext, LifecycleResult>("markerWrites", [false]),
      hasObserved<LifecycleContext, LifecycleResult>("spawnCount", 0),
    ],
  },
] satisfies readonly OperationCase<string, LifecycleInput, LifecycleResult, LifecycleContext>[];

const table: OperationTable<LifecycleFixture, string, LifecycleInput, LifecycleResult, LifecycleContext> = {
  defaultFixture: () => ({ fixture: createFixture("running") }),
  fixtures: {
    running: () => ({ fixture: createFixture("running") }),
    startable: () => ({ fixture: createFixture("startable") }),
    timeout: () => ({ fixture: createFixture("timeout") }),
    stale: () => ({ fixture: createFixture("stale") }),
    foreground: () => ({ fixture: createFixture("foreground") }),
    restartable: () => ({ fixture: createFixture("restartable") }),
    "service-manager": () => ({ fixture: createFixture("service-manager") }),
    "stop-timeout": () => ({ fixture: createFixture("stop-timeout") }),
  },
  cases,
  execute: (fixture, input) => {
    switch (input.operation) {
      case "ensure":
        return fixture.service.ensure.execute(options);
      case "restart":
        return fixture.service.restart.execute({ ...options, refreshServers: input.refreshServers });
      case "start-background":
        return fixture.service.start.execute({ options, foreground: false });
      case "start-foreground":
        return fixture.service.start.execute({ options, foreground: true });
      case "status":
        return fixture.service.status.execute(options);
      case "stop":
        return fixture.service.stop.execute(options);
    }
  },
  observe: (fixture, result) => {
    const value = result.ok ? result.value : undefined;
    return {
      outcomeState:
        value && "state" in value ? value.state : value && "result" in value ? value.result.state : undefined,
      outcomeKind: value && "kind" in value ? value.kind : undefined,
      errorReason: result.ok
        ? undefined
        : result.error instanceof DaemonHealthError
          ? result.error.details.reason
          : undefined,
      spawnCount: fixture.spawnCount,
      signalCount: fixture.signalCount,
      terminateCount: fixture.terminateCount,
      removePidCount: fixture.removePidCount,
      markerWrites: fixture.markerWrites,
      sleeps: fixture.sleeps,
    };
  },
};

function createFixture(key: string): LifecycleFixture {
  const fixture: LifecycleFixture = {
    healthy: key === "running" || key === "restartable" || key === "service-manager" || key === "stop-timeout",
    healthyAfterSpawn: key === "startable" || key === "foreground" || key === "restartable",
    healthyAfterStop: key === "service-manager",
    alive: key !== "stale" && key !== "foreground",
    record:
      key === "stale" ||
      key === "running" ||
      key === "restartable" ||
      key === "service-manager" ||
      key === "stop-timeout"
        ? { pid: 401, host: options.host, port: options.port, startedAt: "2026-08-23T00:00:00.000Z" }
        : undefined,
    now: 0,
    sleeps: [],
    spawnCount: 0,
    signalCount: 0,
    terminateCount: 0,
    removePidCount: 0,
    markerWrites: [],
    service: undefined as unknown as LifecycleFixture["service"],
  };

  const runtime: DaemonRuntimePort = {
    runForeground: async () => ({ code: 0, interrupted: false }),
    spawn: async () => {
      fixture.spawnCount += 1;
      fixture.alive = true;
      if (fixture.healthyAfterSpawn) fixture.healthy = true;
      return {
        pid: 402,
        terminate: () => {
          fixture.terminateCount += 1;
          fixture.alive = false;
        },
      };
    },
    isHealthy: async () => fixture.healthy,
    isAlive: async () => fixture.alive,
    signal: () => {
      fixture.signalCount += 1;
      if (key !== "stop-timeout") fixture.alive = false;
      if (fixture.healthyAfterStop) fixture.healthy = true;
      else fixture.healthy = false;
    },
    readPidRecord: () => fixture.record,
    writePidRecord: () => undefined,
    removePidRecord: () => {
      fixture.removePidCount += 1;
      fixture.record = undefined;
    },
    writeRestartMarker: (_pidFile, refreshServers) => fixture.markerWrites.push(refreshServers),
    hasRestartMarker: () => false,
    consumeRestartMarker: () => undefined,
    removeRestartMarker: () => undefined,
  };
  const timing = {
    runtime,
    clock: { now: () => fixture.now },
    scheduler: {
      sleep: async (milliseconds: number) => {
        fixture.sleeps.push(milliseconds);
        fixture.now += milliseconds;
      },
    },
    lifecycleTimeoutMs: 100,
  };
  const ensure = new EnsureDaemon(timing);
  const stop = new StopDaemon(timing);
  fixture.service = {
    ensure,
    restart: new RestartDaemon({ ...timing, stop }),
    start: new StartDaemon({ ...timing, ensure }),
    status: new StatusDaemon(timing),
    stop,
  };
  return fixture;
}

describe("daemon lifecycle use cases", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
