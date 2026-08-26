import { classifyMuximodError, isMuximodApiError } from "./muximod-error.js";

const authenticationRetryLimit = 1;
const transientRetryLimit = 2;
const retryBaseDelayMs = 1_000;
const retryMaxDelayMs = 30_000;
const rateLimitReconnectDelayMs = 60_000;

/**
 * Central query retry policy. Mutations deliberately do not use this policy:
 * retrying a mutation could duplicate a side effect.
 */
export function shouldRetryMuximodQuery(failureCount: number, error: unknown): boolean {
  if (isMuximodApiError(error)) {
    if (error.status === 401) return failureCount < authenticationRetryLimit;
    if (error.status === 408 || error.status === 425 || error.status >= 500)
      return failureCount < transientRetryLimit;
    return false;
  }

  return classifyMuximodError(error) === "network" && failureCount < transientRetryLimit;
}

export function muximodRetryDelay(attemptIndex: number): number {
  return Math.min(retryBaseDelayMs * 2 ** attemptIndex, retryMaxDelayMs);
}

export function shouldReconnectMuximodEvents(error: unknown): boolean {
  if (!isMuximodApiError(error)) return true;
  if (
    error.status === 401 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.code === "challenge_rate_limited"
  )
    return true;
  return error.status >= 500;
}

export function muximodEventReconnectDelay(attemptIndex: number, error?: unknown): number {
  if (isMuximodApiError(error) && (error.status === 429 || error.code === "challenge_rate_limited"))
    return rateLimitReconnectDelayMs;
  return muximodRetryDelay(attemptIndex);
}
