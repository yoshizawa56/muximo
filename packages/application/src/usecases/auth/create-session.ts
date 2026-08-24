import type { AuthChallengeStorePort, AuthCryptoPort, AuthStorePort, Clock } from "../../ports/auth.js";
import type { AuthSessionResponse } from "../../ports/auth-types.js";
import { AuthStoreError } from "./auth-errors.js";
import { requireActiveDevice } from "./device-guard.js";

const SESSION_TTL_MS = 15 * 60_000;

export async function createAuthSession(
  deps: {
    store: AuthStorePort;
    crypto: AuthCryptoPort;
    challenges: AuthChallengeStorePort;
    serverId: string;
    clock: Clock;
  },
  input: { deviceId: string; challengeId: string; signature: string },
): Promise<AuthSessionResponse> {
  const challenge = deps.challenges.take(input.challengeId);
  const now = deps.clock.now();
  const nowIso = now.toISOString();
  if (!challenge || challenge.deviceId !== input.deviceId || challenge.expiresAt <= nowIso) {
    throw new AuthStoreError("challenge_invalid", "authentication challenge is invalid or expired");
  }
  const device = await requireActiveDevice(deps.store, deps.serverId, input.deviceId);
  const message = deps.crypto.sessionMessage({
    serverId: deps.serverId,
    deviceId: input.deviceId,
    challengeId: challenge.challengeId,
    challengeNonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
  });
  if (!deps.crypto.verifyPublicKeySignature(device.publicKey, message, input.signature)) {
    throw new AuthStoreError("session_signature_invalid", "session signature is invalid");
  }

  const sessionId = deps.crypto.randomOpaque(24);
  const accessToken = deps.crypto.randomOpaque(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  await deps.store.createSession({ sessionId, token: accessToken, deviceId: device.deviceId, expiresAt });
  return { serverId: deps.serverId, deviceId: device.deviceId, sessionId, accessToken, expiresAt };
}
