import { Effect } from "effect";
import type {
  AuthChallengeStorePort,
  AuthCryptoPort,
  AuthRateLimitStorePort,
  AuthStorePort,
  Clock,
} from "../../ports/auth.js";
import { AuthStoreError } from "./auth-errors.js";
import { requireActiveDevice } from "./device-guard.js";

export const authChallengeTtlMs = 60_000;
export const authRateWindowMs = 60_000;
export const authRateWindowMax = 10;

export const createChallenge = Effect.fn("Auth.createChallenge")(function* (
  deps: {
    store: AuthStorePort;
    crypto: AuthCryptoPort;
    challenges: AuthChallengeStorePort;
    rateLimits: AuthRateLimitStorePort;
    serverId: string;
    clock: Clock;
  },
  deviceId: string,
) {
  const device = yield* requireActiveDevice(deps.store, deps.serverId, deviceId);
  const now = deps.clock.now();
  const nowMs = now.getTime();
  const window = deps.rateLimits.window(deviceId);
  if (!window || nowMs - window.startedAt >= authRateWindowMs) {
    deps.rateLimits.setWindow(deviceId, { startedAt: nowMs, count: 1 });
  } else {
    if (window.count >= authRateWindowMax) {
      return yield* Effect.fail(
        new AuthStoreError("challenge_rate_limited", "too many authentication challenges requested"),
      );
    }
    window.count += 1;
  }
  const challengeId = deps.crypto.randomOpaque(24);
  const nonce = deps.crypto.randomOpaque(32);
  const expiresAt = new Date(nowMs + authChallengeTtlMs).toISOString();
  deps.challenges.put({ challengeId, deviceId, nonce, expiresAt });
  return { serverId: deps.serverId, deviceId: device.deviceId, challengeId, nonce, expiresAt };
});
