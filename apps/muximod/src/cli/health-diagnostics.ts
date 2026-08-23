import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLogFile, errorMessage } from "@muximo/infrastructure";
import type { MuximodCliOptions } from "../daemon.js";

type MuximodHealthFailureContext = {
  startedAt: number;
  pid?: number;
};

const healthLogScanLimit = 64;
const healthDiagnosticLimit = 5;
const healthDiagnosticMessageLimit = 512;

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
    lines = readFileSync(logFile, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0);
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
  const message =
    typeof fields?.message === "string"
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
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncateHealthDiagnostic(value: string): string {
  return value.length <= healthDiagnosticMessageLimit ? value : `${value.slice(0, healthDiagnosticMessageLimit - 1)}…`;
}
