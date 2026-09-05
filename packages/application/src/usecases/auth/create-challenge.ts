import { Effect } from "effect";
import { AuthStoreError } from "./auth-errors.js";
import {
  AuthChallengeStoreService,
  AuthClockService,
  AuthCryptoService,
  AuthRateLimitStoreService,
  AuthServerIdService,
} from "./auth-services.js";
import { requireActiveDevice } from "./device-guard.js";

export const authChallengeTtlMs = 60_000;
export const authRateWindowMs = 60_000;
export const authRateWindowMax = 10;

export const createChallenge = Effect.fn("Auth.createChallenge")(function* (deviceId: string) {
  const crypto = yield* AuthCryptoService;
  const challenges = yield* AuthChallengeStoreService;
  const rateLimits = yield* AuthRateLimitStoreService;
  const clock = yield* AuthClockService;
  const serverId = yield* AuthServerIdService;
  const device = yield* requireActiveDevice(deviceId);
  const now = clock.now();
  const nowMs = now.getTime();
  const window = rateLimits.window(deviceId);
  if (!window || nowMs - window.startedAt >= authRateWindowMs) {
    rateLimits.setWindow(deviceId, { startedAt: nowMs, count: 1 });
  } else {
    if (window.count >= authRateWindowMax) {
      return yield* Effect.fail(
        new AuthStoreError("challenge_rate_limited", "too many authentication challenges requested"),
      );
    }
    window.count += 1;
  }
  const challengeId = crypto.randomOpaque(24);
  const nonce = crypto.randomOpaque(32);
  const expiresAt = new Date(nowMs + authChallengeTtlMs).toISOString();
  challenges.put({ challengeId, deviceId, nonce, expiresAt });
  return { serverId, deviceId: device.deviceId, challengeId, nonce, expiresAt };
});
