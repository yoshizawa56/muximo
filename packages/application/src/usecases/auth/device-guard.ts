import { Effect } from "effect";
import type { AuthStorePort } from "../../ports/auth.js";
import type { AuthSessionRecord } from "../../ports/auth-types.js";
import { AuthStoreError } from "./auth-errors.js";

export const requireActiveDevice = Effect.fn("Auth.requireActiveDevice")(function* (
  store: AuthStorePort,
  serverId: string,
  deviceId: string,
) {
  const device = yield* store.findDevice(deviceId);
  if (!device || device.serverId !== serverId || device.status !== "active") {
    return yield* Effect.fail(new AuthStoreError("device_inactive", "device is not active"));
  }
  return device;
});

export const contextForSession = Effect.fn("Auth.contextForSession")(function* (
  store: AuthStorePort,
  session: AuthSessionRecord,
) {
  const device = yield* store.findDevice(session.deviceId);
  if (device?.status !== "active") return undefined;
  return { ...session, device };
});
