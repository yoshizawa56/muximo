import type { ApplicationEffect } from "../effect.js";
import type { ProcessResult } from "./agent-sessions.js";

/** Operational configuration for the managed muximod service. */
export type DaemonOptions = {
  host: string;
  port: number;
  pidFile: string;
  controlSocket?: string;
  logLevel?: "error" | "warn" | "info" | "debug";
  logFile?: string;
  refreshServers?: boolean;
  allowedOrigins?: readonly string[];
};

export type DaemonPidRecord = {
  pid: number;
  host: string;
  port: number;
  startedAt: string;
};

export type DaemonHealthFailureReason =
  | "healthy_without_pid"
  | "pid_unhealthy"
  | "startup_failed"
  | "startup_timeout"
  | "stop_timeout";

export type DaemonHealthFailureContext = {
  startedAt: number;
  pid?: number;
  process?: ProcessResult;
};

export class DaemonHealthError extends Error {
  public readonly details: {
    reason: DaemonHealthFailureReason;
    options: Pick<DaemonOptions, "logFile">;
    context: DaemonHealthFailureContext;
  };

  public constructor(
    reason: DaemonHealthFailureReason,
    options: Pick<DaemonOptions, "logFile">,
    context: DaemonHealthFailureContext,
  ) {
    super(reason);
    this.name = "DaemonHealthError";
    this.details = { reason, options, context };
  }
}

export type DaemonStatusResult =
  | { state: "running"; host: string; port: number; pid?: number }
  | {
      state: "unhealthy";
      host: string;
      port: number;
      pid: number;
      logFile?: string;
      healthFailure: DaemonHealthFailureContext;
    }
  | { state: "stopped"; host: string; port: number };

export type DaemonStopResult = { state: "already-stopped"; reason: "missing-pid" | "stale-pid" } | { state: "stopped" };

export type DaemonRestartResult =
  | { state: "restarted-by-service-manager"; host: string; port: number }
  | { state: "restarted"; host: string; port: number };

export type DaemonEnsureResult =
  | { state: "already-running"; host: string; port: number }
  | { state: "started"; host: string; port: number };

export type DaemonStartResult =
  | { kind: "foreground"; process: ProcessResult }
  | { kind: "background"; result: DaemonEnsureResult };

/** OS process/filesystem/health capabilities supplied by infrastructure. */
export interface DaemonRuntimePort {
  runForeground(options: DaemonOptions): ApplicationEffect<ProcessResult>;
  spawn(options: DaemonOptions): ApplicationEffect<DaemonProcessHandle>;
  isHealthy(options: DaemonOptions, expectedPid?: number): ApplicationEffect<boolean>;
  /** Checks ownership without requiring the process to match a new config. */
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

export type DaemonProcessHandle = {
  pid?: number;
  wait(): ApplicationEffect<ProcessResult>;
  terminate(signal: "SIGTERM"): ApplicationEffect<void>;
};

export type DaemonClock = {
  now(): number;
};

export type DaemonScheduler = {
  sleep(milliseconds: number): ApplicationEffect<void>;
};
