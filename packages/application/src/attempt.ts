import { Effect } from "effect";

/**
 * Runs a synchronous computation, converting a throw into a typed failure
 * instead of a defect. Use where sync domain or validation code that signals
 * with throws (entity update methods, hook path checks, pid-record reads) is
 * invoked inside an Effect program. The thrown Error instance itself becomes
 * the failure, so its code and tag keep flowing to boundary mapping. Static
 * narrowing of the failure channel is a later step together with port error
 * unions; the static type stays Error like the surrounding ports.
 */
export function attemptSync<A>(evaluate: () => A): Effect.Effect<A, Error, never> {
  return Effect.suspend((): Effect.Effect<A, Error, never> => {
    try {
      return Effect.succeed(evaluate());
    } catch (error) {
      return Effect.fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
