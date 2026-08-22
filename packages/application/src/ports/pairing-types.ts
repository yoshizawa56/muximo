// Pairing control-channel data owned by the pairing ports.
export type PairDeviceInput = {
  muximodBaseUrl: string;
};

export type PairingOffer = {
  pairingId: string;
  pairingCode: string;
  muximodBaseUrl: string;
  expiresAt: number;
};

export type PairingClaim = {
  pairingId: string;
  serverId: string;
  deviceName: string;
  deviceType: PairingDeviceType;
  platform: string | null;
  clientVersion: string | null;
  keyFingerprint: string;
  expiresAt: string;
};

export type PairingDeviceType = "browser" | "native" | "cli";

export type ApprovedDevice = {
  deviceId: string;
};
