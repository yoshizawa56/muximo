import type {
  AuthChallengeResponse,
  AuthDeviceRecord,
  AuthPairingClaimNotification,
  AuthPairingClaimRequest,
  AuthPairingClaimResponse,
  AuthPairingPayload,
  AuthPairingRecord,
  AuthPairingStatus,
  AuthSessionRecord,
  AuthSessionResponse,
  ClaimPairingInput,
  ClaimPairingResult,
  CreatePairingInput,
  CreatePairingResult,
  MuximodAuthContext,
  PublicKeyJwk,
  WsTicketResponse,
} from "./auth-types.js";

export interface AuthStorePort {
  getServerId(): string;
  createPairing(input: CreatePairingInput): CreatePairingResult;
  findPairing(pairingId: string): AuthPairingRecord | null;
  claimPairing(input: ClaimPairingInput): ClaimPairingResult;
  getPairingStatus(pairingId: string, claimToken: string): { status: AuthPairingStatus; deviceId: string | null };
  approvePairing(pairingId: string): AuthDeviceRecord;
  rejectPairing(pairingId: string): void;
  findDevice(deviceId: string): AuthDeviceRecord | null;
  createSession(input: { sessionId: string; token: string; deviceId: string; expiresAt: string }): AuthSessionRecord;
  findSession(token: string): AuthSessionRecord | null;
  findSessionById(sessionId: string): AuthSessionRecord | null;
  revokeSession(sessionId: string): void;
  revokeDevice(deviceId: string): void;
  listDevices(): AuthDeviceRecord[];
}

export interface MuximodAuthControlPort {
  createPairing(overrides?: { muximodBaseUrl?: string }): AuthPairingPayload;
  approvePairing(pairingId: string): AuthDeviceRecord;
  rejectPairing(pairingId: string): void;
  setPairingClaimListener(listener: ((notification: AuthPairingClaimNotification) => void) | undefined): void;
}

export interface AuthCryptoPort {
  randomOpaque(bytes: number): string;
  hashOpaque(value: string): string;
  fingerprint(publicKey: PublicKeyJwk): string;
  pairingClaimMessage(input: {
    serverId: string;
    pairingId: string;
    pairingSecretHash: string;
    keyFingerprint: string;
    clientNonce: string;
  }): string;
  sessionMessage(input: {
    serverId: string;
    deviceId: string;
    challengeId: string;
    challengeNonce: string;
    expiresAt: string;
  }): string;
  verifyPublicKeySignature(publicKey: PublicKeyJwk, message: string, signature: string): boolean;
  parsePublicKey(value: string): PublicKeyJwk;
}

export interface MuximodAuthPort {
  readonly serverId: string;
  authenticateAccessToken(token: string | undefined): MuximodAuthContext | null;
  claimPairing(pairingId: string, request: AuthPairingClaimRequest): AuthPairingClaimResponse;
  pairingStatus(pairingId: string, claimToken: string): { status: AuthPairingStatus; deviceId: string | null };
  createChallenge(deviceId: string): AuthChallengeResponse;
  createSession(input: { deviceId: string; challengeId: string; signature: string }): AuthSessionResponse;
  issueWebSocketTicket(context: MuximodAuthContext, endpoint: "terminal"): WsTicketResponse;
  consumeWebSocketTicket(ticket: string | undefined, endpoint: "terminal"): MuximodAuthContext | null;
}
