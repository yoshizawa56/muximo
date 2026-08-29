import type { AuthCryptoPort, AuthStorePort, Clock } from "../../ports/auth.js";
import type { AuthPairingPayload } from "../../ports/auth-types.js";

const PAIRING_TTL_MS = 5 * 60_000;

export async function startPairing(
  deps: { store: AuthStorePort; crypto: AuthCryptoPort; clock: Clock },
  input: { muximodBaseUrl: string },
): Promise<AuthPairingPayload> {
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  const pairing = await deps.store.createPairing({
    muximodBaseUrl: input.muximodBaseUrl,
    expiresAt: expiresAt.toISOString(),
    secret: deps.crypto.randomOpaque(32),
  });
  return {
    v: 2,
    muximodBaseUrl: pairing.muximodBaseUrl,
    serverId: pairing.serverId,
    pairingId: pairing.pairingId,
    pairingSecret: pairing.secret,
    expiresAt: expiresAt.getTime(),
  };
}
