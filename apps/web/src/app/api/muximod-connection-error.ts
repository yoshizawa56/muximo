import { isMuximodApiError, isMuximodNetworkError, muximodErrorDetails } from "./muximod-error.js";

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

function errorDetails(cause: unknown): string {
  if (isMuximodApiError(cause)) return muximodErrorDetails(cause);
  if (isMuximodNetworkError(cause)) {
    return `${muximodErrorDetails(cause)} (HTTP status unavailable: the browser did not expose a response; check CORS, TLS, or network connectivity)`;
  }
  if (cause instanceof Error && cause.name && cause.message) return `${cause.name}: ${cause.message}`;
  return muximodErrorDetails(cause);
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
