import type { PublicKeyJwk } from "@muximo/domain";

export type { PublicKeyJwk } from "@muximo/domain";

export type AuthDeviceType = "browser" | "native" | "cli";
export type AuthDeviceStatus = "active" | "revoked";
export type AuthPairingStatus = "offered" | "awaiting_approval" | "approved" | "rejected" | "expired";

export type AuthDeviceRecord = {
  deviceId: string;
  serverId: string;
  publicKeyJwk: string;
  keyFingerprint: string;
  displayName: string;
  deviceType: AuthDeviceType;
  platform: string | null;
  clientVersion: string | null;
  status: AuthDeviceStatus;
  createdAt: string;
  approvedAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
};

export type AuthPairingRecord = {
  pairingId: string;
  serverId: string;
  muximodBaseUrl: string;
  status: AuthPairingStatus;
  offeredAt: string;
  expiresAt: string;
  claimExpiresAt: string | null;
  claimedAt: string | null;
  approvedAt: string | null;
  pendingPublicKeyJwk: string | null;
  pendingFingerprint: string | null;
  pendingDisplayName: string | null;
  pendingDeviceType: AuthDeviceType | null;
  pendingPlatform: string | null;
  pendingClientVersion: string | null;
  deviceId: string | null;
};

export type AuthSessionRecord = {
  sessionId: string;
  serverId: string;
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type CreatePairingInput = {
  muximodBaseUrl: string;
  expiresAt: string;
  secret: string;
};

export type CreatePairingResult = {
  pairingId: string;
  serverId: string;
  secret: string;
  muximodBaseUrl: string;
  expiresAt: string;
};

export type ClaimPairingInput = {
  pairingId: string;
  secretHash: string;
  claimToken: string;
  claimExpiresAt: string;
  publicKeyJwk: string;
  keyFingerprint: string;
  displayName: string;
  deviceType: AuthDeviceType;
  platform: string | null;
  clientVersion: string | null;
};

export type ClaimPairingResult = {
  pairing: AuthPairingRecord;
  claimToken: string;
};

export type AuthPairingClaimRequest = {
  pairingSecret: string;
  publicKey: PublicKeyJwk;
  deviceName: string;
  deviceType: AuthDeviceType;
  platform?: string;
  clientVersion?: string;
  clientNonce: string;
  signature: string;
};

export type AuthPairingClaimResponse = {
  serverId: string;
  pairingId: string;
  claimToken: string;
  status: "awaiting_approval";
  expiresAt: string;
  keyFingerprint: string;
};

export type AuthPairingPayload = {
  v: 2;
  muximodBaseUrl: string;
  serverId: string;
  pairingId: string;
  pairingSecret: string;
  expiresAt: number;
};

export type AuthPairingClaimNotification = {
  pairingId: string;
  serverId: string;
  deviceName: string;
  deviceType: AuthDeviceType;
  platform: string | null;
  clientVersion: string | null;
  keyFingerprint: string;
  expiresAt: string;
};

export type AuthChallengeResponse = {
  serverId: string;
  deviceId: string;
  challengeId: string;
  nonce: string;
  expiresAt: string;
};

export type AuthSessionResponse = {
  serverId: string;
  deviceId: string;
  sessionId: string;
  accessToken: string;
  expiresAt: string;
};

export type WsTicketResponse = {
  ticket: string;
  endpoint: "terminal";
  expiresAt: string;
};

export type MuximodAuthDevice = AuthDeviceRecord;

export type MuximodAuthContext = AuthSessionRecord & {
  device: MuximodAuthDevice;
};
