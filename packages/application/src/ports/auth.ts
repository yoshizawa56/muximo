import type { ApplicationEffect } from "../effect.js";
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

export interface Clock {
  now(): Date;
}

/** Semantic capability for disconnecting active authenticated connections. */
export interface AuthConnectionPort {
  disconnectDevice(deviceId: string): ApplicationEffect<void>;
  disconnectSession(sessionId: string): ApplicationEffect<void>;
}

export interface AuthStorePort {
  createPairing(input: CreatePairingInput): ApplicationEffect<CreatePairingResult>;
  findPairing(pairingId: string): ApplicationEffect<AuthPairingRecord | undefined>;
  claimPairing(input: ClaimPairingInput): ApplicationEffect<ClaimPairingResult>;
  getPairingStatus(
    pairingId: string,
    claimToken: string,
  ): ApplicationEffect<{ status: AuthPairingStatus; deviceId?: string }>;
  approvePairing(pairingId: string): ApplicationEffect<AuthDeviceRecord>;
  rejectPairing(pairingId: string): ApplicationEffect<void>;
  findDevice(deviceId: string): ApplicationEffect<AuthDeviceRecord | undefined>;
  createSession(input: {
    sessionId: string;
    token: string;
    deviceId: string;
    expiresAt: string;
  }): ApplicationEffect<AuthSessionRecord>;
  findSession(token: string): ApplicationEffect<AuthSessionRecord | undefined>;
  findSessionById(sessionId: string): ApplicationEffect<AuthSessionRecord | undefined>;
  revokeSession(sessionId: string): ApplicationEffect<void>;
  revokeDevice(deviceId: string): ApplicationEffect<void>;
  listDevices(): ApplicationEffect<AuthDeviceRecord[]>;
}

export interface AuthPairingClaimSinkPort {
  publish(notification: AuthPairingClaimNotification): ApplicationEffect<void>;
}

export interface MuximodAuthControlPort {
  createLocalSession(): ApplicationEffect<AuthSessionResponse>;
  createPairing(input: { muximodBaseUrl: string }): ApplicationEffect<AuthPairingPayload>;
  approvePairing(pairingId: string): ApplicationEffect<AuthDeviceRecord>;
  rejectPairing(pairingId: string): ApplicationEffect<void>;
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
}

export interface MuximodAuthPort {
  readonly serverId: string;
  authenticateAccessToken(token: string | undefined): ApplicationEffect<MuximodAuthContext | undefined>;
  claimPairing(pairingId: string, request: AuthPairingClaimRequest): ApplicationEffect<AuthPairingClaimResponse>;
  pairingStatus(
    pairingId: string,
    claimToken: string,
  ): ApplicationEffect<{ status: AuthPairingStatus; deviceId?: string }>;
  createChallenge(deviceId: string): ApplicationEffect<AuthChallengeResponse>;
  createSession(input: {
    deviceId: string;
    challengeId: string;
    signature: string;
  }): ApplicationEffect<AuthSessionResponse>;
  issueWebSocketTicket(context: MuximodAuthContext, endpoint: "terminal"): ApplicationEffect<WsTicketResponse>;
  consumeWebSocketTicket(
    ticket: string | undefined,
    endpoint: "terminal",
  ): ApplicationEffect<MuximodAuthContext | undefined>;
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
  take(challengeId: string): PendingChallengeRecord | undefined;
  sweepExpired(nowIso: string): void;
  size(): number;
}

/** Raw sliding-window buckets; the limit policy lives in the application. */
export interface AuthRateLimitStorePort {
  window(deviceId: string): ChallengeRateWindow | undefined;
  setWindow(deviceId: string, window: ChallengeRateWindow): void;
  sweepExpired(nowMs: number): void;
}

export interface AuthWsTicketStorePort {
  put(ticketHash: string, record: PendingWsTicketRecord): void;
  take(ticketHash: string): PendingWsTicketRecord | undefined;
  sweepExpired(nowIso: string): void;
}
