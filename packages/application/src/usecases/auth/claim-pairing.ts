import { Effect } from "effect";
import type { AuthCryptoPort, AuthPairingClaimSinkPort, AuthStorePort, Clock } from "../../ports/auth.js";
import type { AuthPairingClaimRequest } from "../../ports/auth-types.js";
import { AuthStoreError } from "./auth-errors.js";

const CLAIM_TTL_MS = 10 * 60_000;

export const claimPairing = Effect.fn("Auth.claimPairing")(function* (
  deps: {
    store: AuthStorePort;
    crypto: AuthCryptoPort;
    serverId: string;
    clock: Clock;
    claimSink: AuthPairingClaimSinkPort;
  },
  pairingId: string,
  request: AuthPairingClaimRequest,
) {
  const keyFingerprint = deps.crypto.fingerprint(request.publicKey);
  const secretHash = deps.crypto.hashOpaque(request.pairingSecret);
  const message = deps.crypto.pairingClaimMessage({
    serverId: deps.serverId,
    pairingId,
    pairingSecretHash: secretHash,
    keyFingerprint,
    clientNonce: request.clientNonce,
  });
  if (!deps.crypto.verifyPublicKeySignature(request.publicKey, message, request.signature)) {
    return yield* Effect.fail(new AuthStoreError("claim_signature_invalid", "pairing claim signature is invalid"));
  }

  const claimToken = deps.crypto.randomOpaque(32);
  const now = deps.clock.now();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
  yield* deps.store.claimPairing({
    pairingId,
    secretHash,
    claimToken,
    claimExpiresAt,
    publicKey: request.publicKey,
    keyFingerprint,
    displayName: request.deviceName,
    deviceType: request.deviceType,
    ...(request.platform === undefined ? {} : { platform: request.platform }),
    ...(request.clientVersion === undefined ? {} : { clientVersion: request.clientVersion }),
  });

  yield* deps.claimSink.publish({
    pairingId,
    serverId: deps.serverId,
    deviceName: request.deviceName,
    deviceType: request.deviceType,
    ...(request.platform === undefined ? {} : { platform: request.platform }),
    ...(request.clientVersion === undefined ? {} : { clientVersion: request.clientVersion }),
    keyFingerprint,
    expiresAt: claimExpiresAt,
  });
  return {
    serverId: deps.serverId,
    pairingId,
    claimToken,
    status: "awaiting_approval" as const,
    expiresAt: claimExpiresAt,
    keyFingerprint,
  };
});
