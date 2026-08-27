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
  disconnectDevice(deviceId: string): Promise<void>;
  disconnectSession(sessionId: string): Promise<void>;
}

export interface AuthStorePort {
  createPairing(input: CreatePairingInput): Promise<CreatePairingResult>;
  findPairing(pairingId: string): Promise<AuthPairingRecord | undefined>;
  claimPairing(input: ClaimPairingInput): Promise<ClaimPairingResult>;
  getPairingStatus(pairingId: string, claimToken: string): Promise<{ status: AuthPairingStatus; deviceId?: string }>;
  approvePairing(pairingId: string): Promise<AuthDeviceRecord>;
  rejectPairing(pairingId: string): Promise<void>;
  findDevice(deviceId: string): Promise<AuthDeviceRecord | undefined>;
  createSession(input: {
    sessionId: string;
    token: string;
    deviceId: string;
    expiresAt: string;
  }): Promise<AuthSessionRecord>;
  findSession(token: string): Promise<AuthSessionRecord | undefined>;
  findSessionById(sessionId: string): Promise<AuthSessionRecord | undefined>;
  revokeSession(sessionId: string): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  listDevices(): Promise<AuthDeviceRecord[]>;
}

export interface AuthPairingClaimSinkPort {
  publish(notification: AuthPairingClaimNotification): void | Promise<void>;
}

export interface MuximodAuthControlPort {
  createLocalSession(): Promise<AuthSessionResponse>;
  createPairing(overrides?: { muximodBaseUrl?: string }): Promise<AuthPairingPayload>;
  approvePairing(pairingId: string): Promise<AuthDeviceRecord>;
  rejectPairing(pairingId: string): Promise<void>;
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
  authenticateAccessToken(token: string | undefined): Promise<MuximodAuthContext | undefined>;
  claimPairing(pairingId: string, request: AuthPairingClaimRequest): Promise<AuthPairingClaimResponse>;
  pairingStatus(pairingId: string, claimToken: string): Promise<{ status: AuthPairingStatus; deviceId?: string }>;
  createChallenge(deviceId: string): Promise<AuthChallengeResponse>;
  createSession(input: { deviceId: string; challengeId: string; signature: string }): Promise<AuthSessionResponse>;
  issueWebSocketTicket(context: MuximodAuthContext, endpoint: "terminal"): Promise<WsTicketResponse>;
  consumeWebSocketTicket(ticket: string | undefined, endpoint: "terminal"): Promise<MuximodAuthContext | undefined>;
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
