import type { AuthCryptoPort, AuthStorePort } from "../../ports/auth.js";
import type { AuthPairingPayload } from "../../ports/auth-types.js";

const PAIRING_TTL_MS = 5 * 60_000;

export function startPairing(
  deps: { store: AuthStorePort; crypto: AuthCryptoPort; muximodBaseUrl: string; now?: () => Date },
  overrides: { muximodBaseUrl?: string } = {},
): AuthPairingPayload {
  const now = deps.now?.() ?? new Date();
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  const pairing = deps.store.createPairing({
    muximodBaseUrl: overrides.muximodBaseUrl ?? deps.muximodBaseUrl,
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
