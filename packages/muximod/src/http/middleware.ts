import { z } from "zod";
import type { MuximodHttpStatus, MuximodOriginPolicy } from "./types.js";

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
    const mappedError = mapExternalError(error.code, error.message);
    const status = errorStatus(mappedError.code, error.status);
    const details = isRecord(error.details) ? error.details : undefined;
    return new MuximodHttpError(status, mappedError.code, mappedError.message, details);
  }
  return new MuximodHttpError(503, "muximod_unavailable", "muximod could not complete the request");
}

/** Maps application failures to the HTTP vocabulary. */
function mapExternalError(code: string, message: string): { code: string; message: string } {
  if (code === "terminal_host_unavailable") return { code: "tmux_unavailable", message: "tmux is unavailable" };
  if (code === "terminal_host_pane_not_found") {
    return { code: "tmux_pane_not_found", message: message.replace("terminal host ", "tmux ") };
  }
  if (code === "session_not_found") {
    return { code, message: message.replace("terminal host session", "tmux session") };
  }
  if (code === "session_exists") {
    return { code, message: message.replace("terminal host session", "tmux session") };
  }
  if (code === "session_not_visible") {
    return { code, message: "tmux created the session but muximod could not read it" };
  }
  if (code === "pane_not_visible") {
    return { code, message: "tmux created the pane but muximod could not read it" };
  }
  return { code, message };
}

export function errorStatus(code: string, status: unknown): MuximodHttpStatus {
  if (isMuximodHttpStatus(status)) return status;
  if (code === "pairing_not_found" || code === "workspace_not_found") return 404;
  if (code === "operation_not_found") return 404;
  if (code === "pairing_expired" || code === "claim_token_expired") return 410;
  if (
    code === "pairing_unavailable" ||
    code === "pairing_not_awaiting_approval" ||
    code === "pairing_not_rejectable" ||
    code === "session_exists" ||
    code === "workspace_already_registered" ||
    code === "workspace_name_ambiguous" ||
    code === "operation_idempotency_conflict" ||
    code === "operation_already_started"
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

export function createOriginPolicy(input: {
  allowedOrigins: readonly string[];
  allowNoOrigin: boolean;
}): MuximodOriginPolicy {
  if (input.allowedOrigins.some((origin) => origin === "*")) {
    throw new Error("wildcard origins are not allowed for authenticated routes");
  }
  const allowedOrigins = new Set(
    [muximoCapacitorOrigin, ...input.allowedOrigins].map((origin) => normalizeOrigin(origin)),
  );
  return {
    allows(origin) {
      return origin === null ? input.allowNoOrigin : allowedOrigins.has(origin);
    },
  };
}

/** Fixed origin used by the bundled iOS Capacitor shell. */
export const muximoCapacitorOrigin = "capacitor://localhost";

export function errorResponse(error: unknown, request: Request, originPolicy: MuximodOriginPolicy): Response {
  const mapped = mapError(error);
  return corsResponse(errorBody(mapped), request, originPolicy, mapped.status);
}

export function errorBody(error: MuximodHttpError): {
  error: string;
  message: string;
  details?: Record<string, unknown>;
} {
  return { error: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
}

export function notFound(request: Request, originPolicy: MuximodOriginPolicy): Response {
  return corsResponse({ error: "not_found", message: "Route not found" }, request, originPolicy, 404);
}

export function corsResponse(
  body: unknown,
  request: Request,
  originPolicy: MuximodOriginPolicy,
  status = 200,
): Response {
  return withCors(jsonResponse(body, status), request, originPolicy);
}

export function jsonResponse(body: unknown, status = 200): Response {
  const response =
    body === undefined
      ? new Response(null, { status })
      : new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return response;
}

export function withCors(response: Response, request: Request, originPolicy: MuximodOriginPolicy): Response {
  const origin = request.headers.get("origin");
  if (!origin || !originPolicy.allows(origin)) return response;
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

export function originDeniedResponse(): Response {
  return new Response(JSON.stringify({ error: "origin_not_allowed", message: "Request origin is not allowed" }), {
    status: 403,
    headers: { "content-type": "application/json" },
  });
}

function normalizeOrigin(origin: string): string {
  if (!origin || origin.trim() !== origin) throw new Error("allowed origins must be non-empty exact origins");
  if (origin === muximoCapacitorOrigin) return origin;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`invalid allowed origin: ${origin}`);
  }
  if (parsed.origin !== origin || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    throw new Error(`allowed origin must be an exact supported origin: ${origin}`);
  }
  return origin;
}
