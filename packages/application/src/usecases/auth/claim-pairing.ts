import type { AuthCryptoPort, AuthStorePort } from "../../ports/auth.js";
import type {
  AuthPairingClaimNotification,
  AuthPairingClaimRequest,
  AuthPairingClaimResponse,
} from "../../ports/auth-types.js";
import { AuthStoreError } from "./auth-errors.js";

const CLAIM_TTL_MS = 10 * 60_000;

export function claimPairing(
  deps: {
    store: AuthStorePort;
    crypto: AuthCryptoPort;
    serverId: string;
    now?: () => Date;
    onClaimed?: (notification: AuthPairingClaimNotification) => void;
  },
  pairingId: string,
  request: AuthPairingClaimRequest,
): AuthPairingClaimResponse {
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
    throw new AuthStoreError("claim_signature_invalid", "pairing claim signature is invalid");
  }

  const claimToken = deps.crypto.randomOpaque(32);
  const now = deps.now?.() ?? new Date();
  const claimExpiresAt = new Date(now.getTime() + CLAIM_TTL_MS).toISOString();
  const _result = deps.store.claimPairing({
    pairingId,
    secretHash,
    claimToken,
    claimExpiresAt,
    publicKeyJwk: JSON.stringify(request.publicKey),
    keyFingerprint,
    displayName: request.deviceName,
    deviceType: request.deviceType,
    platform: request.platform ?? null,
    clientVersion: request.clientVersion ?? null,
  });

  deps.onClaimed?.({
    pairingId,
    serverId: deps.serverId,
    deviceName: request.deviceName,
    deviceType: request.deviceType,
    platform: request.platform ?? null,
    clientVersion: request.clientVersion ?? null,
    keyFingerprint,
    expiresAt: claimExpiresAt,
  });
  return {
    serverId: deps.serverId,
    pairingId,
    claimToken,
    status: "awaiting_approval",
    expiresAt: claimExpiresAt,
    keyFingerprint,
  };
}
