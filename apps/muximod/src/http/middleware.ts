import { z } from "zod";
import type { MuximodHttpStatus } from "./types.js";

export class MuximodHttpError extends Error {
  public constructor(
    public readonly status: MuximodHttpStatus,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MuximodHttpError";
  }
}

export function mapError(error: unknown): MuximodHttpError {
  if (error instanceof MuximodHttpError) return error;
  if (error instanceof z.ZodError) return new MuximodHttpError(400, "invalid_request", "Request validation failed");
  if (isRecord(error) && typeof error.code === "string" && typeof error.message === "string") {
    const status = errorStatus(error.code, error.status);
    const details = isRecord(error.details) ? error.details : undefined;
    return new MuximodHttpError(status, error.code, error.message, details);
  }
  return new MuximodHttpError(503, "muximod_unavailable", "muximod could not complete the request");
}

export function errorStatus(code: string, status: unknown): MuximodHttpStatus {
  if (isMuximodHttpStatus(status)) return status;
  if (code === "pairing_not_found" || code === "workspace_not_found") return 404;
  if (code === "pairing_expired" || code === "claim_token_expired") return 410;
  if (
    code === "pairing_unavailable" ||
    code === "pairing_not_awaiting_approval" ||
    code === "pairing_not_rejectable" ||
    code === "session_exists" ||
    code === "workspace_already_registered" ||
    code === "workspace_name_ambiguous"
  )
    return 409;
  if (
    code === "claim_token_invalid" ||
    code === "claim_signature_invalid" ||
    code === "session_signature_invalid" ||
    code === "challenge_invalid" ||
    code === "device_inactive"
  )
    return 401;
  if (code === "challenge_rate_limited") return 429;
  if (code === "session_not_visible" || code === "pane_not_visible" || code === "tmux_unavailable") return 503;
  return 400;
}

export function isMuximodHttpStatus(value: unknown): value is MuximodHttpStatus {
  return (
    value === 400 ||
    value === 401 ||
    value === 403 ||
    value === 404 ||
    value === 409 ||
    value === 410 ||
    value === 426 ||
    value === 429 ||
    value === 500 ||
    value === 503
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function errorResponse(error: unknown, origin: string): Response {
  const mapped = mapError(error);
  return corsResponse(errorBody(mapped), origin, mapped.status);
}

export function errorBody(error: MuximodHttpError): {
  error: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
}

export function notFound(origin: string): Response {
  return corsResponse({ error: "not_found", message: "Route not found" }, origin, 404);
}

export function corsResponse(body: unknown, origin: string, status = 200): Response {
  return withCors(jsonResponse(body, status), origin);
}

export function jsonResponse(body: unknown, status = 200): Response {
  const response =
    body === undefined
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return response;
}

export function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set(
    "access-control-allow-headers",
    "content-type, authorization, x-muximod-pairing-token, x-muximod-hook-token",
  );
  headers.set("vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
