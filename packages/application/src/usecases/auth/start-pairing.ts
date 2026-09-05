import { Effect } from "effect";
import { AuthClockService, AuthCryptoService, AuthStoreService } from "./auth-services.js";

const PAIRING_TTL_MS = 5 * 60_000;

export const startPairing = Effect.fn("Auth.startPairing")(function* (input: { muximodBaseUrl: string }) {
  const store = yield* AuthStoreService;
  const crypto = yield* AuthCryptoService;
  const clock = yield* AuthClockService;
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  const pairing = yield* store.createPairing({
    muximodBaseUrl: input.muximodBaseUrl,
    expiresAt: expiresAt.toISOString(),
    secret: crypto.randomOpaque(32),
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
