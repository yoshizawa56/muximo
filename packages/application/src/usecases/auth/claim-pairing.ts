import { Effect } from "effect";
import type { AuthPairingClaimRequest } from "../../ports/auth-types.js";
import { AuthStoreError } from "./auth-errors.js";
import {
  AuthClockService,
  AuthCryptoService,
  AuthPairingClaimSinkService,
  AuthServerIdService,
  AuthStoreService,
} from "./auth-services.js";

const CLAIM_TTL_MS = 10 * 60_000;

export const claimPairing = Effect.fn("Auth.claimPairing")(function* (
  pairingId: string,
  request: AuthPairingClaimRequest,
) {
  const store = yield* AuthStoreService;
  const crypto = yield* AuthCryptoService;
  const clock = yield* AuthClockService;
  const claimSink = yield* AuthPairingClaimSinkService;
  const serverId = yield* AuthServerIdService;
  const keyFingerprint = crypto.fingerprint(request.publicKey);
  const secretHash = crypto.hashOpaque(request.pairingSecret);
  const message = crypto.pairingClaimMessage({
    serverId,
    pairingId,
    pairingSecretHash: secretHash,
    keyFingerprint,
    clientNonce: request.clientNonce,
  });
  if (!crypto.verifyPublicKeySignature(request.publicKey, message, request.signature)) {
    return yield* Effect.fail(new AuthStoreError("claim_signature_invalid", "pairing claim signature is invalid"));
  }

  const claimToken = crypto.randomOpaque(32);
  const now = clock.now();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
  yield* store.claimPairing({
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

  yield* claimSink.publish({
    pairingId,
    serverId,
    deviceName: request.deviceName,
    deviceType: request.deviceType,
    ...(request.platform === undefined ? {} : { platform: request.platform }),
    ...(request.clientVersion === undefined ? {} : { clientVersion: request.clientVersion }),
    keyFingerprint,
    expiresAt: claimExpiresAt,
  });
  return {
    serverId,
    pairingId,
    claimToken,
    status: "awaiting_approval" as const,
    expiresAt: claimExpiresAt,
    keyFingerprint,
  };
});
