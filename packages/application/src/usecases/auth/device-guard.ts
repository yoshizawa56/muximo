import type { AuthStorePort } from "../../ports/auth.js";
import type { AuthDeviceRecord, AuthSessionRecord, MuximodAuthContext } from "../../ports/auth-types.js";
import { AuthStoreError } from "./auth-errors.js";

export function requireActiveDevice(store: AuthStorePort, serverId: string, deviceId: string): AuthDeviceRecord {
  const device = store.findDevice(deviceId);
  if (!device || device.serverId !== serverId || device.status !== "active") {
    throw new AuthStoreError("device_inactive", "device is not active");
  }
  return device;
}

export function contextForSession(store: AuthStorePort, session: AuthSessionRecord): MuximodAuthContext | null {
  const device = store.findDevice(session.deviceId);
  if (device?.status !== "active") return null;
  return { ...session, device };
}
