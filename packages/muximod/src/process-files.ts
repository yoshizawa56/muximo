import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DaemonPidRecord } from "@muximo/application";

export function writeMuximodPidRecord(path: string, record: DaemonPidRecord): void {
  writePrivateJson(path, record);
}

export function removeMuximodPidRecord(path: string, expectedPid: number): void {
  const record = readMuximodPidRecord(path);
  if (record?.pid !== expectedPid) return;
  try {
    unlinkSync(path);
  } catch {
    // Another lifecycle operation may have removed the record already.
  }
}

export function readMuximodPidRecord(path: string): DaemonPidRecord | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined;
    throw new Error(`muximod pid file could not be read: ${path}`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(`muximod pid file contains invalid JSON: ${path}`, { cause: error });
  }
  if (!isDaemonPidRecord(parsed)) throw new Error(`muximod pid file has an invalid format: ${path}`);
  return parsed;
}

export function writeMuximodRestartMarker(path: string, refreshServers: boolean): void {
  const marker = `${path}.restart`;
  writePrivateJson(marker, { pid: process.pid, refreshServers, startedAt: new Date().toISOString() });
}

export function hasMuximodRestartMarker(path: string): boolean {
  return existsSync(`${path}.restart`);
}

export function removeMuximodRestartMarker(path: string): void {
  try {
    unlinkSync(`${path}.restart`);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

export function consumeMuximodRestartMarker(path: string): boolean | undefined {
  const marker = `${path}.restart`;
  if (!existsSync(marker)) return undefined;
  let refreshServers: boolean;
  try {
    const parsed: unknown = JSON.parse(readFileSync(marker, "utf8"));
    if (!isRestartMarkerRecord(parsed)) throw new Error("restart marker does not match the current format");
    refreshServers = parsed.refreshServers;
  } catch (error) {
    throw new Error(`muximod restart marker has an invalid format: ${marker}`, { cause: error });
  }
  try {
    unlinkSync(marker);
  } catch {
    // The marker may already have been removed.
  }
  return refreshServers;
}

function isDaemonPidRecord(value: unknown): value is DaemonPidRecord {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).sort().join(",") === "host,pid,port,startedAt" &&
    isPositiveInteger(value.pid) &&
    typeof value.host === "string" &&
    value.host.length > 0 &&
    isPort(value.port) &&
    typeof value.startedAt === "string" &&
    isIsoTimestamp(value.startedAt)
  );
}

function isRestartMarkerRecord(value: unknown): value is { pid: number; refreshServers: boolean; startedAt: string } {
  if (!isRecord(value)) return false;
  return (
    Object.keys(value).sort().join(",") === "pid,refreshServers,startedAt" &&
    isPositiveInteger(value.pid) &&
    typeof value.refreshServers === "boolean" &&
    typeof value.startedAt === "string" &&
    isIsoTimestamp(value.startedAt)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
  return isPositiveInteger(value) && value <= 65_535;
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let operationError: unknown;
  let operationFailed = false;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    unlinkSync(temporaryPath);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) cleanupError = error;
  }
  if (operationFailed) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
}
