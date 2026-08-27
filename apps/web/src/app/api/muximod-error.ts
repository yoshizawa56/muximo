export type MuximodApiErrorDetails = Record<string, unknown> | null;

export type MuximodApiErrorLike = {
  message: string;
  status: number;
  code: string | null;
  details?: MuximodApiErrorDetails;
};

export class MuximodApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string | null,
    public readonly details: MuximodApiErrorDetails,
  ) {
    super(message);
    this.name = "MuximodApiError";
  }
}

export type MuximodErrorCategory = "authentication" | "rate_limited" | "client" | "server" | "network" | "unknown";

export function isMuximodApiError(value: unknown): value is MuximodApiErrorLike {
  if (!isRecord(value)) return false;
  return (
    typeof value.message === "string" &&
    typeof value.status === "number" &&
    (typeof value.code === "string" || value.code === null || value.code === undefined)
  );
}

export function classifyMuximodError(error: unknown): MuximodErrorCategory {
  if (isMuximodApiError(error)) {
    if (error.status === 401) return "authentication";
    if (error.status === 429 || error.code === "challenge_rate_limited") return "rate_limited";
    if (error.status >= 500) return "server";
    if (error.status >= 400) return "client";
    return "unknown";
  }

  if (isMuximodNetworkError(error)) return "network";
  return "unknown";
}

/**
 * Returns a safe message for UI surfaces. It never includes protocol details
 * or arbitrary error fields that could accidentally expose credentials.
 */
export function muximodErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (isMuximodApiError(error)) {
    const category = classifyMuximodError(error);
    if (category === "authentication") return "Muximod authentication expired. Please retry.";
    if (category === "rate_limited")
      return "Muximod is temporarily rate limiting requests. Please wait a moment and try again.";
    return readMessage(error.message) ?? fallback;
  }

  if (error instanceof Error) return readMessage(error.message) ?? fallback;
  if (typeof error === "string") return readMessage(error) ?? fallback;

  if (isRecord(error)) {
    const name = readMessage(error.name);
    const message = readMessage(error.message);
    if (name && message) return `${name}: ${message}`;
    if (message) return message;
  }

  try {
    const serialized = JSON.stringify(safeErrorFields(error));
    return serialized && serialized !== "{}" ? serialized : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Formats protocol details for pairing diagnostics. This intentionally keeps
 * server messages but excludes the response details object from the output.
 */
export function muximodErrorDetails(error: unknown): string {
  if (isMuximodApiError(error)) {
    const protocolDetails = [`HTTP ${error.status}`, error.code ? `code=${error.code}` : null]
      .filter((value): value is string => value !== null)
      .join(", ");
    const message = readMessage(error.message) ?? "Unknown error";
    return protocolDetails ? `${message} (${protocolDetails})` : message;
  }

  if (error instanceof Error) {
    const name = readMessage(error.name);
    const message = readMessage(error.message);
    if (name && message) return `${name}: ${message}`;
    if (message) return message;
  }

  return muximodErrorMessage(error);
}

export function isMuximodNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "TypeError" || error.name === "NetworkError";
}

function safeErrorFields(error: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (!isRecord(error)) return fields;
  for (const key of ["code", "status", "name"] as const) {
    const value = error[key];
    if (typeof value === "string" || typeof value === "number") fields[key] = value;
  }
  return fields;
}

function readMessage(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
