import type {
  AuthChallengeStorePort,
  AuthCryptoPort,
  AuthRateLimitStorePort,
  AuthStorePort,
} from "../../ports/auth.js";
import type { AuthChallengeResponse } from "../../ports/auth-types.js";
import { AuthStoreError } from "./auth-errors.js";
import { requireActiveDevice } from "./device-guard.js";

const CHALLENGE_TTL_MS = 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_WINDOW_MAX = 10;
const CHALLENGE_SWEEP_THRESHOLD = 1_000;

export function createChallenge(
  deps: {
    store: AuthStorePort;
    crypto: AuthCryptoPort;
    challenges: AuthChallengeStorePort;
    rateLimits: AuthRateLimitStorePort;
    serverId: string;
    now?: () => Date;
  },
  deviceId: string,
): AuthChallengeResponse {
  const device = requireActiveDevice(deps.store, deps.serverId, deviceId);
  const now = deps.now?.() ?? new Date();
  const nowMs = now.getTime();
  const window = deps.rateLimits.window(deviceId);
  if (!window || nowMs - window.startedAt >= RATE_WINDOW_MS) {
    deps.rateLimits.setWindow(deviceId, { startedAt: nowMs, count: 1 });
  } else {
    if (window.count >= RATE_WINDOW_MAX)
      throw new AuthStoreError("challenge_rate_limited", "too many authentication challenges requested");
    window.count += 1;
  }
  if (deps.challenges.size() > CHALLENGE_SWEEP_THRESHOLD) {
    deps.challenges.sweepExpired(now.toISOString());
  }
  const challengeId = deps.crypto.randomOpaque(24);
  const nonce = deps.crypto.randomOpaque(32);
  const expiresAt = new Date(nowMs + CHALLENGE_TTL_MS).toISOString();
  deps.challenges.put({ challengeId, deviceId, nonce, expiresAt });
  return { serverId: deps.serverId, deviceId: device.deviceId, challengeId, nonce, expiresAt };
}
