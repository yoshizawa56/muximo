import type {
  DaemonHealthError,
  DaemonRestartResult,
  DaemonStartResult,
  DaemonStatusResult,
  DaemonStopResult,
} from "@muximo/application";
import type { MuximodDaemonStatus } from "@muximo/contract/control";
import {
  formatHumanRecord,
  type MuximodLogFileLine,
  type MuximodLogFileReadResult,
} from "@muximo/infrastructure/cli-client";
import type { CliIo } from "../commands/types.js";

export function presentDaemonStart(result: DaemonStartResult, io: CliIo): number {
  const prefix = result.result.state === "already-running" ? "muximod already running" : "muximod started";
  io.out.write(`[muximo-cli] ${prefix}${formatEndpoint(result.result.host, result.result.port)}\n`);
  return 0;
}

export function presentDaemonStatus(
  result: DaemonStatusResult,
  io: CliIo,
  clientVersion?: string,
  daemonStatus?: MuximodDaemonStatus,
): number {
  if (result.state === "running") {
    io.out.write(
      `[muximo-cli] muximod running${result.pid === undefined ? "" : ` (pid ${result.pid})`}${formatEndpoint(result.host, result.port)}\n`,
    );
    presentDaemonDiagnostics(io, clientVersion, daemonStatus);
    return 0;
  }
  if (result.state === "unhealthy") {
    io.err.write(
      `${presentHealthFailure(
        `[muximo-cli] muximod process ${result.pid} exists but is not healthy at http://${displayDaemonHost(result.host)}:${result.port}`,
        result.logFile,
      )}\n`,
    );
    return 1;
  }
  io.out.write("[muximo-cli] muximod stopped\n");
  return 1;
}

function presentDaemonDiagnostics(
  io: CliIo,
  clientVersion: string | undefined,
  daemonStatus: MuximodDaemonStatus | undefined,
): void {
  if (daemonStatus) io.out.write(`[muximo-cli] daemon version: ${daemonStatus.daemonVersion}\n`);
  if (clientVersion) io.out.write(`[muximo-cli] client version: ${clientVersion}\n`);
  if (!daemonStatus) {
    io.out.write(
      "[muximo-cli] configuration status is unavailable; muximod continues with its startup configuration\n",
    );
    return;
  }
  if (daemonStatus.configuration.state === "current") {
    io.out.write("[muximo-cli] configuration is current\n");
    return;
  }
  if (daemonStatus.configuration.state === "unavailable") {
    io.out.write(
      "[muximo-cli] configuration status is unavailable; muximod continues with its startup configuration\n",
    );
    return;
  }
  io.out.write(
    `[muximo-cli] configuration changed; restart recommended for: ${daemonStatus.configuration.changedKeys.join(", ")}\n`,
  );
  io.out.write('[muximo-cli] run "muximo daemon restart" to apply the configuration\n');
}

export function presentDaemonStop(result: DaemonStopResult, io: CliIo): number {
  if (result.state === "stopped") {
    io.out.write("[muximo-cli] muximod stopped\n");
  } else {
    io.out.write(
      result.reason === "stale-pid"
        ? "[muximo-cli] muximod was already stopped; removed stale pid file\n"
        : "[muximo-cli] muximod is already stopped\n",
    );
  }
  return 0;
}

export function presentDaemonRestart(result: DaemonRestartResult, io: CliIo): number {
  io.out.write(`[muximo-cli] muximod restarted${formatEndpoint(result.host, result.port)}\n`);
  return 0;
}

/** Renders one muximod log line for humans by default or as raw JSON with --json. */
export function renderDaemonLogLine(line: MuximodLogFileLine, json: boolean): string {
  if (json || line.record === undefined) return line.raw;
  return formatHumanRecord(line.record);
}

export function presentDaemonLog(
  result: MuximodLogFileReadResult & { followed: boolean },
  io: CliIo,
  json = false,
): number {
  if (result.followed) {
    if (result.state === "missing") {
      io.out.write(`[muximo-cli] muximod log file does not exist yet: ${result.logFile}\n`);
      io.out.write("[muximo-cli] waiting for the log file; press Ctrl+C to stop\n");
    }
    return 0;
  }
  if (result.state === "missing") {
    io.err.write(`[muximo-cli] error: muximod log file was not found: ${result.logFile}\n`);
    io.err.write(
      '[muximo-cli] hint: muximod creates the log when it first starts for this instance directory; check "--instance-dir" if the daemon runs elsewhere\n',
    );
    return 1;
  }
  if (result.state === "empty") {
    io.out.write(`[muximo-cli] muximod log file is empty: ${result.logFile}\n`);
    return 0;
  }
  for (const line of result.lines) io.out.write(`${renderDaemonLogLine(line, json)}\n`);
  return 0;
}

export function presentDaemonError(error: DaemonHealthError, io: CliIo, fallbackLogFile?: string): number {
  const logFile = error.details.options.logFile ?? fallbackLogFile;
  io.err.write(`${presentHealthFailure(`[muximo-cli] error: ${healthErrorMessage(error)}`, logFile)}\n`);
  return 1;
}

function presentHealthFailure(message: string, logFile: string | undefined): string {
  return logFile
    ? `${message}\nmuximod log: ${logFile}\ninspect it with "muximo daemon log" (works while muximod is stopped)`
    : message;
}

function healthErrorMessage(error: DaemonHealthError): string {
  const { reason, context } = error.details;
  if (reason === "healthy_without_pid") return "muximod is healthy but its pid file is missing";
  if (reason === "pid_unhealthy") {
    return context.pid === undefined
      ? "muximod process state is inconsistent with its pid file"
      : `muximod process ${context.pid} is not owned by the selected instance; inspect the pid file, then run "muximo daemon restart" to apply the selected configuration if this is the expected muximod`;
  }
  if (reason === "startup_failed") {
    const diagnostic = context.process?.failureDiagnostic ? `: ${context.process.failureDiagnostic}` : "";
    if (context.process?.signal)
      return `muximod exited during startup with signal ${context.process.signal}${diagnostic}`;
    if (context.process) return `muximod exited during startup with exit code ${context.process.code}${diagnostic}`;
    return "muximod failed during startup";
  }
  if (reason === "stop_timeout") return "muximod did not stop before the lifecycle deadline";
  return "muximod did not become healthy before the startup deadline";
}

function displayDaemonHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function formatEndpoint(host: string | undefined, port: number | undefined): string {
  return host === undefined || port === undefined ? "" : ` at http://${displayDaemonHost(host)}:${port}`;
}
