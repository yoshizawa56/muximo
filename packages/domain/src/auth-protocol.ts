/** Canonical public-key shape shared by authentication ports and transports. */
export type PublicKeyJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

/**
 * Authentication signatures cover canonical messages owned by the core.
 * Keeping the format here prevents host crypto adapters and clients from
 * silently signing different payloads.
 */
export function canonicalPublicJwk(jwk: PublicKeyJwk): string {
  return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
}

export function pairingClaimMessage(input: {
  serverId: string;
  pairingId: string;
  pairingSecretHash: string;
  keyFingerprint: string;
  clientNonce: string;
}): string {
  return [
    "MA-PAIR-CLAIM-V1",
    input.serverId,
    input.pairingId,
    input.pairingSecretHash,
    input.keyFingerprint,
    input.clientNonce,
  ].join("\n") + "\n";
}

export function sessionMessage(input: {
  serverId: string;
  deviceId: string;
  challengeId: string;
  challengeNonce: string;
  expiresAt: string;
}): string {
  return [
    "MA-SESSION-V1",
    input.serverId,
    input.deviceId,
    input.challengeId,
    input.challengeNonce,
    input.expiresAt,
  ].join("\n") + "\n";
}
