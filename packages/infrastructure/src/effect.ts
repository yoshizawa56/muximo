import type { ApplicationEffect } from "@muximo/application";
import { Effect } from "effect";

/**
 * Adapts an existing asynchronous capability while preserving Error instances
 * and making rejected promises part of the Effect error channel.
 *
 * This is the single lifting point for Promise/callback I/O into Effects:
 * each adapter method wraps at most once here; callers compose the resulting
 * Effect with yield* instead of wrapping again at the call site.
 */
export function fromPromise<A>(evaluate: (signal: AbortSignal) => A | PromiseLike<A>): ApplicationEffect<A> {
  return Effect.tryPromise({
    try: (signal) => Promise.resolve().then(() => evaluate(signal)),
    catch: normalizeError,
  });
}

export function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : String(error);
    return Object.assign(new Error(message), record);
  }
  return new Error(String(error));
}

/**
 * Temporary migration bridge for infrastructure adapters whose callers still
 * expose Promise methods while the underlying capability already returns an
 * Effect. The bridged Effect must require no services. Do not use in new
 * application orchestration; yield the Effect directly wherever the caller can
 * remain an Effect. Remove with the owning Promise boundary.
 */
export function runEffectAsPromise<A>(effect: ApplicationEffect<A>): Promise<A> {
  return Effect.runPromise(effect);
}
