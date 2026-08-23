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
import type { MuximodSocket } from "./socket.js";

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

/** One-time challenge awaiting a signed session request. */
export type PendingChallengeRecord = {
  challengeId: string;
  deviceId: string;
  nonce: string;
  expiresAt: string;
};

/** One-use WebSocket upgrade ticket keyed by its hash. */
export type PendingWsTicketRecord = {
  sessionId: string;
  endpoint: "terminal";
  expiresAt: string;
};

export type ChallengeRateWindow = { startedAt: number; count: number };

/** Ephemeral challenge storage owned by the infrastructure layer. */
export interface AuthChallengeStorePort {
  put(record: PendingChallengeRecord): void;
  /** Atomically read-and-delete (one-time use). */
  take(challengeId: string): PendingChallengeRecord | null;
  sweepExpired(nowIso: string): void;
  size(): number;
}

/** Raw sliding-window buckets; the limit policy lives in the application. */
export interface AuthRateLimitStorePort {
  window(deviceId: string): ChallengeRateWindow | null;
  setWindow(deviceId: string, window: ChallengeRateWindow): void;
}

export interface AuthWsTicketStorePort {
  put(ticketHash: string, record: PendingWsTicketRecord): void;
  take(ticketHash: string): PendingWsTicketRecord | null;
}

/** Live terminal sockets grouped by session, closed on expiry or revocation. */
export interface TrackedSocketRegistryPort {
  track(input: { sessionId: string; deviceId: string; socket: MuximodSocket; expiresAtMs: number }): void;
  closeForDevice(deviceId: string, code: number, reason: string): void;
}
