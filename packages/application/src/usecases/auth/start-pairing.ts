import { Effect } from "effect";
import type { AuthCryptoPort, AuthStorePort, Clock } from "../../ports/auth.js";

const PAIRING_TTL_MS = 5 * 60_000;

export const startPairing = Effect.fn("Auth.startPairing")(function* (
  deps: { store: AuthStorePort; crypto: AuthCryptoPort; clock: Clock },
  input: { muximodBaseUrl: string },
) {
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  const pairing = yield* deps.store.createPairing({
    muximodBaseUrl: input.muximodBaseUrl,
    expiresAt: expiresAt.toISOString(),
    secret: deps.crypto.randomOpaque(32),
  });
  return {
    v: 2 as const,
    muximodBaseUrl: pairing.muximodBaseUrl,
    serverId: pairing.serverId,
    pairingId: pairing.pairingId,
    pairingSecret: pairing.secret,
    expiresAt: expiresAt.getTime(),
  };
});
