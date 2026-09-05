import { Context, Layer } from "effect";
import type { ApplicationEffect } from "../../effect.js";
import type { ProcessResult } from "../../ports/agent-sessions.js";
import type { DaemonOptions, DaemonPidRecord } from "../../ports/daemon.js";

export interface DaemonRuntime {
  runForeground(options: DaemonOptions): ApplicationEffect<ProcessResult>;
  spawn(options: DaemonOptions): ApplicationEffect<DaemonProcessHandle>;
  isHealthy(options: DaemonOptions, expectedPid?: number): ApplicationEffect<boolean>;
  isProcessHealthy(options: Pick<DaemonOptions, "host" | "port">, expectedPid: number): ApplicationEffect<boolean>;
  isAlive(pid: number): ApplicationEffect<boolean>;
  signal(pid: number, signal: "SIGTERM"): ApplicationEffect<void>;
  readPidRecord(path: string): ApplicationEffect<DaemonPidRecord | undefined>;
  writePidRecord(path: string, record: DaemonPidRecord): ApplicationEffect<void>;
  removePidRecord(path: string, expectedPid: number): ApplicationEffect<void>;
  writeRestartMarker(path: string, refreshServers: boolean): ApplicationEffect<void>;
  hasRestartMarker(path: string): ApplicationEffect<boolean>;
  consumeRestartMarker(path: string): ApplicationEffect<boolean | undefined>;
  removeRestartMarker(path: string): ApplicationEffect<void>;
}

export interface DaemonClock {
  now(): number;
}

export interface DaemonScheduler {
  sleep(milliseconds: number): ApplicationEffect<void>;
}

/** Process handle returned by the daemon runtime capability. */
export type DaemonProcessHandle = {
  pid?: number;
  wait(): ApplicationEffect<ProcessResult>;
  terminate(signal: "SIGTERM"): ApplicationEffect<void>;
};

/** OS process, filesystem, and health capability for the daemon. */
export class DaemonRuntimeService extends Context.Service<DaemonRuntimeService, DaemonRuntime>()(
  "@muximo/application/DaemonRuntime",
) {}

/** Monotonic wall-clock capability for daemon lifecycle policy. */
export class DaemonClockService extends Context.Service<DaemonClockService, DaemonClock>()(
  "@muximo/application/DaemonClock",
) {}

/** Sleep capability for daemon lifecycle polling. */
export class DaemonSchedulerService extends Context.Service<DaemonSchedulerService, DaemonScheduler>()(
  "@muximo/application/DaemonScheduler",
) {}

/** Daemon lifecycle timing configuration supplied by the composition root. */
export type DaemonLifecycleConfig = {
  lifecycleTimeoutMs: number;
};

/** Daemon lifecycle timing configuration service. */
export class DaemonLifecycleConfigService extends Context.Service<
  DaemonLifecycleConfigService,
  DaemonLifecycleConfig
>()("@muximo/application/DaemonLifecycleConfig") {}

/** Services required by daemon lifecycle use cases. */
export type DaemonServices =
  | DaemonRuntimeService
  | DaemonClockService
  | DaemonSchedulerService
  | DaemonLifecycleConfigService;

export const daemonRuntimeLayer = (runtime: DaemonRuntime): Layer.Layer<DaemonRuntimeService> =>
  Layer.succeed(DaemonRuntimeService, runtime);

export const daemonClockLayer = (clock: DaemonClock): Layer.Layer<DaemonClockService> =>
  Layer.succeed(DaemonClockService, clock);

export const daemonSchedulerLayer = (scheduler: DaemonScheduler): Layer.Layer<DaemonSchedulerService> =>
  Layer.succeed(DaemonSchedulerService, scheduler);

export const daemonLifecycleConfigLayer = (config: DaemonLifecycleConfig): Layer.Layer<DaemonLifecycleConfigService> =>
  Layer.succeed(DaemonLifecycleConfigService, config);

/** Assembles all daemon lifecycle services from concrete implementations. */
export const daemonLayer = (dependencies: {
  runtime: DaemonRuntime;
  clock: DaemonClock;
  scheduler: DaemonScheduler;
  lifecycleTimeoutMs: number;
}): Layer.Layer<DaemonServices> =>
  Layer.mergeAll(
    daemonRuntimeLayer(dependencies.runtime),
    daemonClockLayer(dependencies.clock),
    daemonSchedulerLayer(dependencies.scheduler),
    daemonLifecycleConfigLayer({ lifecycleTimeoutMs: dependencies.lifecycleTimeoutMs }),
  );
