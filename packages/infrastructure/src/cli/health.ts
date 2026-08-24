import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLogFile, errorMessage } from "../logging/index.js";

export type DaemonHealthDiagnostic = {
  level: "WARN" | "ERROR";
  event: string;
  message?: string;
  code?: string;
  errorId?: string;
};

export type DaemonHealthDiagnostics = {
  logFile: string;
  diagnostics: readonly DaemonHealthDiagnostic[];
};

export function readDaemonHealthDiagnostics(
  logFile: string | undefined,
  context: { startedAt: number; pid?: number },
): DaemonHealthDiagnostics {
  const path = resolve(logFile ?? defaultLogFile());
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-64);
  } catch {
    return { logFile: path, diagnostics: [] };
  }
  const diagnostics = lines
    .map((line) => parseDiagnostic(line, context))
    .filter((value): value is DaemonHealthDiagnostic => value !== undefined)
    .slice(-5);
  return { logFile: path, diagnostics };
}

function parseDiagnostic(
  line: string,
  context: { startedAt: number; pid?: number },
): DaemonHealthDiagnostic | undefined {
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
  return {
    level: record.level === "warn" ? "WARN" : "ERROR",
    event: typeof record.event === "string" ? record.event : "unknown",
    message:
      typeof fields?.message === "string"
        ? truncate(errorMessage(fields.message))
        : typeof error?.message === "string"
          ? truncate(errorMessage(error.message))
          : undefined,
    code: typeof error?.code === "string" || typeof error?.code === "number" ? String(error.code) : undefined,
    errorId: typeof fields?.errorId === "string" ? fields.errorId : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncate(value: string): string {
  return value.length <= 512 ? value : `${value.slice(0, 511)}…`;
}
