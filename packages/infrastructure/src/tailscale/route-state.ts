import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type ServeRouteState = {
  schemaVersion: 2;
  environment?: string;
  component: string;
  provider: "tailscale";
  hostname: string;
  publicUrl: string;
  localTarget: string;
  externalPort: number;
  path: string;
  routeFingerprint: string;
  updatedAt: string;
};

export function readServeRouteState(path: string): ServeRouteState | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return undefined;
    throw new Error(`serve state could not be read: ${path}`, { cause: error });
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`serve state contains invalid JSON: ${path}`, { cause: error });
  }
  if (!isServeRouteState(value)) throw new Error(`serve state has an invalid format: ${path}`);
  return value;
}

export function writeServeRouteState(path: string, state: ServeRouteState): void {
  if (!isServeRouteState(state)) throw new Error(`serve state has an invalid format: ${path}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let operationError: unknown;
  let operationFailed = false;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
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
    if (!isErrorCode(error, "ENOENT")) cleanupError = error;
  }
  if (operationFailed) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
}

export function removeServeRouteState(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isErrorCode(error, "ENOENT")) throw error;
  }
}

function isServeRouteState(value: unknown): value is ServeRouteState {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value).sort().join(",");
  const hasEnvironment = typeof value.environment === "string" && value.environment.length > 0;
  return (
    ((keys ===
      "component,environment,externalPort,hostname,localTarget,path,provider,publicUrl,routeFingerprint,schemaVersion,updatedAt" &&
      hasEnvironment) ||
      (keys ===
        "component,externalPort,hostname,localTarget,path,provider,publicUrl,routeFingerprint,schemaVersion,updatedAt" &&
        value.environment === undefined)) &&
    value.schemaVersion === 2 &&
    typeof value.component === "string" &&
    value.component.length > 0 &&
    value.provider === "tailscale" &&
    typeof value.hostname === "string" &&
    value.hostname.length > 0 &&
    typeof value.publicUrl === "string" &&
    value.publicUrl.length > 0 &&
    typeof value.localTarget === "string" &&
    value.localTarget.length > 0 &&
    typeof value.externalPort === "number" &&
    Number.isInteger(value.externalPort) &&
    value.externalPort >= 1 &&
    value.externalPort <= 65_535 &&
    typeof value.path === "string" &&
    value.path.startsWith("/") &&
    typeof value.routeFingerprint === "string" &&
    value.routeFingerprint.length > 0 &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    new Date(value.updatedAt).toISOString() === value.updatedAt
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
