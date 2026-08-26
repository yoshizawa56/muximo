export type MuximodRequestStage =
  | "requesting server information"
  | "claiming the QR pairing"
  | "checking pairing approval";

export class MuximodConnectionError extends Error {
  public constructor(
    public readonly stage: MuximodRequestStage,
    public readonly endpoint: string,
    public readonly cause: unknown,
  ) {
    super(formatMuximodConnectionError(stage, endpoint, cause));
    this.name = "MuximodConnectionError";
  }
}

export async function withMuximodRequest<Result>(
  endpoint: string,
  stage: MuximodRequestStage,
  request: () => Promise<Result>,
): Promise<Result> {
  try {
    return await request();
  } catch (cause) {
    if (cause instanceof MuximodConnectionError) throw cause;
    throw new MuximodConnectionError(stage, endpoint, cause);
  }
}

export function formatMuximodConnectionError(stage: MuximodRequestStage, endpoint: string, cause: unknown): string {
  const returnedByMuximod = isMuximodApiError(cause);
  const title = returnedByMuximod ? "Muximod returned an error" : "Could not communicate with muximod";
  return [`${title} while ${stage}.`, `Endpoint: ${displayEndpoint(endpoint)}`, `Details: ${errorDetails(cause)}`].join(
    "\n",
  );
}

function isMuximodApiError(value: unknown): value is { message: string; status: number; code: string | null } {
  return (
    isRecord(value) &&
    typeof value.message === "string" &&
    typeof value.status === "number" &&
    (typeof value.code === "string" || value.code === null)
  );
}

function errorDetails(cause: unknown): string {
  if (isMuximodApiError(cause)) {
    const protocolDetails = [`HTTP ${cause.status}`, cause.code ? `code=${cause.code}` : null]
      .filter((value): value is string => value !== null)
      .join(", ");
    return protocolDetails ? `${cause.message} (${protocolDetails})` : cause.message;
  }

  if (typeof cause === "string") return cause.trim() || "Unknown error";
  if (cause == null) return "Unknown error";

  if (isRecord(cause)) {
    const name = readString(cause.name);
    const message = readString(cause.message);
    if (name && message) return `${name}: ${message}`;
    if (message || name) return message ?? name ?? "Unknown error";

    try {
      const serialized = JSON.stringify(cause);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      return "Unknown error";
    }
    return "Unknown error";
  }

  const details = String(cause).trim();
  return details || "Unknown error";
}

function displayEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const value = url.toString();
    return value.endsWith("/") ? value.slice(0, -1) : value;
  } catch {
    return "<invalid endpoint>";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
