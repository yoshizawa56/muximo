import { Effect } from "effect";
import type { AuthSessionRecord } from "../../ports/auth-types.js";
import { AuthStoreError } from "./auth-errors.js";
import { AuthServerIdService, AuthStoreService } from "./auth-services.js";

export const requireActiveDevice = Effect.fn("Auth.requireActiveDevice")(function* (deviceId: string) {
  const store = yield* AuthStoreService;
  const serverId = yield* AuthServerIdService;
  const device = yield* store.findDevice(deviceId);
  if (!device || device.serverId !== serverId || device.status !== "active") {
    return yield* Effect.fail(new AuthStoreError("device_inactive", "device is not active"));
  }
  return device;
});

export const contextForSession = Effect.fn("Auth.contextForSession")(function* (session: AuthSessionRecord) {
  const store = yield* AuthStoreService;
  const device = yield* store.findDevice(session.deviceId);
  if (device?.status !== "active") return undefined;
  return { ...session, device };
});
