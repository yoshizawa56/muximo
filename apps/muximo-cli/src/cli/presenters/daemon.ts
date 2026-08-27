import type {
  DaemonHealthError,
  DaemonRestartResult,
  DaemonStartResult,
  DaemonStatusResult,
  DaemonStopResult,
} from "@muximo/application";
import { type DaemonLogResult, readDaemonHealthDiagnostics } from "@muximo/infrastructure";
import type { CliIo } from "../commands/types.js";

export function presentDaemonStart(result: DaemonStartResult, io: CliIo): number {
  if (result.kind === "foreground") return result.process.code;
  const prefix = result.result.state === "already-running" ? "muximod already running" : "muximod started";
  io.out.write(`${prefix} at http://${displayDaemonHost(result.result.host)}:${result.result.port}\n`);
  return 0;
}

export function presentDaemonStatus(result: DaemonStatusResult, io: CliIo): number {
  if (result.state === "running") {
    io.out.write(
      `muximod running${result.pid === undefined ? "" : ` (pid ${result.pid})`} at http://${displayDaemonHost(result.host)}:${result.port}\n`,
    );
    return 0;
  }
  if (result.state === "unhealthy") {
    io.err.write(
      `${presentHealthFailure(
        `muximod process ${result.pid} exists but is not healthy at http://${displayDaemonHost(result.host)}:${result.port}`,
        result.logFile,
        result.healthFailure,
      )}\n`,
    );
    return 1;
  }
  io.out.write(`muximod stopped at http://${displayDaemonHost(result.host)}:${result.port}\n`);
  return 1;
}

export function presentDaemonStop(result: DaemonStopResult, io: CliIo): number {
  if (result.state === "stopped") {
    io.out.write("muximod stopped\n");
  } else {
    io.out.write(
      result.reason === "stale-pid"
        ? "muximod was already stopped; removed stale pid file\n"
        : "muximod is already stopped\n",
    );
  }
  return 0;
}

export function presentDaemonRestart(result: DaemonRestartResult, io: CliIo): number {
  const prefix =
    result.state === "restarted-by-service-manager" ? "muximod restarted by its service manager" : "muximod restarted";
  io.out.write(`${prefix} at http://${displayDaemonHost(result.host)}:${result.port}\n`);
  return 0;
}

export function presentDaemonLog(result: DaemonLogResult, io: CliIo): number {
  if (result.state === "missing") {
    io.err.write(`muximo: muximod log file was not found: ${result.logFile}\n`);
    return 1;
  }
  if (result.state === "empty") {
    io.out.write(`muximod log file is empty: ${result.logFile}\n`);
    return 0;
  }
  io.out.write(`${result.lines.join("\n")}\n`);
  return 0;
}

export function presentDaemonError(error: DaemonHealthError, io: CliIo): number {
  const result = readDaemonHealthDiagnostics(error.details.options.logFile, error.details.context);
  const lines = [healthErrorMessage(error), `muximod log: ${result.logFile}`];
  if (result.diagnostics.length === 0) {
    lines.push("muximod log: no recent warning or error records");
  } else {
    lines.push(
      "muximod recent diagnostics:",
      ...result.diagnostics.map((diagnostic) => {
        const detail = diagnostic.message ? `: ${diagnostic.message}` : "";
        const code = diagnostic.code ? ` code=${diagnostic.code}` : "";
        const errorId = diagnostic.errorId ? ` errorId=${diagnostic.errorId}` : "";
        return `  ${diagnostic.level} ${diagnostic.event}${detail}${code}${errorId}`;
      }),
    );
  }
  io.err.write(`muximo: ${lines.join("\n")}\n`);
  return 1;
}

function presentHealthFailure(
  message: string,
  logFile: string | undefined,
  context: { startedAt: number; pid?: number },
): string {
  const result = readDaemonHealthDiagnostics(logFile, context);
  const lines = [message, `muximod log: ${result.logFile}`];
  if (result.diagnostics.length === 0) {
    lines.push("muximod log: no recent warning or error records");
  } else {
    lines.push(
      "muximod recent diagnostics:",
      ...result.diagnostics.map((diagnostic) => {
        const detail = diagnostic.message ? `: ${diagnostic.message}` : "";
        const code = diagnostic.code ? ` code=${diagnostic.code}` : "";
        const errorId = diagnostic.errorId ? ` errorId=${diagnostic.errorId}` : "";
        return `  ${diagnostic.level} ${diagnostic.event}${detail}${code}${errorId}`;
      }),
    );
  }
  return lines.join("\n");
}

function healthErrorMessage(error: DaemonHealthError): string {
  const { reason, context } = error.details;
  if (reason === "healthy_without_pid") {
    return "muximod is healthy but its pid file is missing; stop it through its service manager";
  }
  if (reason === "pid_unhealthy") {
    return context.pid === undefined
      ? "muximod process state is inconsistent with its pid file"
      : `refusing to signal pid ${context.pid}; pid file does not point to a healthy muximod`;
  }
  if (reason === "stop_timeout") return "muximod did not stop before the lifecycle deadline";
  return "muximod did not become healthy before the startup deadline";
}

function displayDaemonHost(host: string): string {
  if (host === "0.0.0.0") return "127.0.0.1";
  if (host === "::") return "[::1]";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
