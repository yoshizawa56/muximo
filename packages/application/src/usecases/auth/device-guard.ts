import type { AuthStorePort } from "../../ports/auth.js";
import type { AuthDeviceRecord, AuthSessionRecord, MuximodAuthContext } from "../../ports/auth-types.js";
import { AuthStoreError } from "./auth-errors.js";

export async function requireActiveDevice(
  store: AuthStorePort,
  serverId: string,
  deviceId: string,
): Promise<AuthDeviceRecord> {
  const device = await store.findDevice(deviceId);
  if (!device || device.serverId !== serverId || device.status !== "active") {
    throw new AuthStoreError("device_inactive", "device is not active");
  }
  return device;
}

export async function contextForSession(
  store: AuthStorePort,
  session: AuthSessionRecord,
): Promise<MuximodAuthContext | undefined> {
  const device = await store.findDevice(session.deviceId);
  if (device?.status !== "active") return undefined;
  return { ...session, device };
}
