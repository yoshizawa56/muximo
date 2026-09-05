import { Effect } from "effect";
import { AuthStoreError } from "./auth-errors.js";
import {
  AuthChallengeStoreService,
  AuthClockService,
  AuthCryptoService,
  AuthServerIdService,
  AuthStoreService,
} from "./auth-services.js";
import { requireActiveDevice } from "./device-guard.js";

const SESSION_TTL_MS = 15 * 60_000;

export const createAuthSession = Effect.fn("Auth.createSession")(function* (input: {
  deviceId: string;
  challengeId: string;
  signature: string;
}) {
  const store = yield* AuthStoreService;
  const crypto = yield* AuthCryptoService;
  const challenges = yield* AuthChallengeStoreService;
  const clock = yield* AuthClockService;
  const serverId = yield* AuthServerIdService;
  const challenge = challenges.take(input.challengeId);
  const now = clock.now();
  const nowIso = now.toISOString();
  if (!challenge || challenge.deviceId !== input.deviceId || challenge.expiresAt <= nowIso) {
    return yield* Effect.fail(
      new AuthStoreError("challenge_invalid", "authentication challenge is invalid or expired"),
    );
  }
  const device = yield* requireActiveDevice(input.deviceId);
  const message = crypto.sessionMessage({
    serverId,
    deviceId: input.deviceId,
    challengeId: challenge.challengeId,
    challengeNonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
  });
  if (!crypto.verifyPublicKeySignature(device.publicKey, message, input.signature)) {
    return yield* Effect.fail(new AuthStoreError("session_signature_invalid", "session signature is invalid"));
  }

  const sessionId = crypto.randomOpaque(24);
  const accessToken = crypto.randomOpaque(32);
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();
  yield* store.createSession({ sessionId, token: accessToken, deviceId: device.deviceId, expiresAt });
  return { serverId, deviceId: device.deviceId, sessionId, accessToken, expiresAt };
});
