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
  runForeground(options: DaemonOptions): Promise<ProcessResult>;
  spawn(options: DaemonOptions): Promise<DaemonProcessHandle>;
  isHealthy(options: DaemonOptions, expectedPid?: number): Promise<boolean>;
  /** Checks ownership without requiring the process to match a new config. */
  isProcessHealthy(options: Pick<DaemonOptions, "host" | "port">, expectedPid: number): Promise<boolean>;
  isAlive(pid: number): Promise<boolean>;
  signal(pid: number, signal: "SIGTERM"): void;
  readPidRecord(path: string): DaemonPidRecord | undefined;
  writePidRecord(path: string, record: DaemonPidRecord): void;
  removePidRecord(path: string, expectedPid: number): void;
  writeRestartMarker(path: string, refreshServers: boolean): void;
  hasRestartMarker(path: string): boolean;
  consumeRestartMarker(path: string): boolean | undefined;
  removeRestartMarker(path: string): void;
}

export type DaemonProcessHandle = {
  pid?: number;
  wait(): Promise<ProcessResult>;
  terminate(signal: "SIGTERM"): void;
};

export type DaemonClock = {
  now(): number;
};

export type DaemonScheduler = {
  sleep(milliseconds: number): Promise<void>;
};
