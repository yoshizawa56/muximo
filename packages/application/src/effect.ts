import type { Effect } from "effect";

/** Effect-native application operation with a normalized expected failure. */
export type ApplicationEffect<A, E extends Error = Error, R = never> = Effect.Effect<A, E, R>;
