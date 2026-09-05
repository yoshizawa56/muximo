import { Context, Layer } from "effect";
import type { ApplicationEffect } from "../../effect.js";
import type { ChallengeRateWindow, PendingChallengeRecord, PendingWsTicketRecord } from "../../ports/auth.js";
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
} from "../../ports/auth-types.js";

export interface AuthClock {
  now(): Date;
}

export interface AuthConnection {
  disconnectDevice(deviceId: string): ApplicationEffect<void>;
  disconnectSession(sessionId: string): ApplicationEffect<void>;
}

export interface AuthStore {
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

export interface AuthPairingClaimSink {
  publish(notification: AuthPairingClaimNotification): ApplicationEffect<void>;
}

export interface AuthCrypto {
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

export interface AuthChallengeStore {
  put(record: PendingChallengeRecord): void;
  take(challengeId: string): PendingChallengeRecord | undefined;
  sweepExpired(nowIso: string): void;
  size(): number;
}

export interface AuthRateLimitStore {
  window(deviceId: string): ChallengeRateWindow | undefined;
  setWindow(deviceId: string, window: ChallengeRateWindow): void;
  sweepExpired(nowMs: number): void;
}

export interface AuthWsTicketStore {
  put(ticketHash: string, record: PendingWsTicketRecord): void;
  take(ticketHash: string): PendingWsTicketRecord | undefined;
  sweepExpired(nowIso: string): void;
}

export interface MuximodAuthControl {
  createLocalSession(): ApplicationEffect<AuthSessionResponse>;
  createPairing(input: { muximodBaseUrl: string }): ApplicationEffect<AuthPairingPayload>;
  approvePairing(pairingId: string): ApplicationEffect<AuthDeviceRecord>;
  rejectPairing(pairingId: string): ApplicationEffect<void>;
}

export interface MuximodAuth {
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

/** Authentication wall-clock capability. */
export class AuthClockService extends Context.Service<AuthClockService, AuthClock>()("@muximo/application/AuthClock") {}

/** Authenticated-connection lifecycle capability. */
export class AuthConnectionService extends Context.Service<AuthConnectionService, AuthConnection>()(
  "@muximo/application/AuthConnection",
) {}

/** Durable authentication store capability. */
export class AuthStoreService extends Context.Service<AuthStoreService, AuthStore>()("@muximo/application/AuthStore") {}

/** Pairing-claim notification capability. */
export class AuthPairingClaimSinkService extends Context.Service<AuthPairingClaimSinkService, AuthPairingClaimSink>()(
  "@muximo/application/AuthPairingClaimSink",
) {}

/** Authentication cryptography capability. */
export class AuthCryptoService extends Context.Service<AuthCryptoService, AuthCrypto>()(
  "@muximo/application/AuthCrypto",
) {}

/** Ephemeral authentication challenge storage capability. */
export class AuthChallengeStoreService extends Context.Service<AuthChallengeStoreService, AuthChallengeStore>()(
  "@muximo/application/AuthChallengeStore",
) {}

/** Authentication challenge rate-limit storage capability. */
export class AuthRateLimitStoreService extends Context.Service<AuthRateLimitStoreService, AuthRateLimitStore>()(
  "@muximo/application/AuthRateLimitStore",
) {}

/** One-use WebSocket ticket storage capability. */
export class AuthWsTicketStoreService extends Context.Service<AuthWsTicketStoreService, AuthWsTicketStore>()(
  "@muximo/application/AuthWsTicketStore",
) {}

/** Authentication server identity supplied by the composition root. */
export class AuthServerIdService extends Context.Service<AuthServerIdService, string>()(
  "@muximo/application/AuthServerId",
) {}

/** Transport-facing authentication capability. */
export class MuximodAuthService extends Context.Service<MuximodAuthService, MuximodAuth>()(
  "@muximo/application/MuximodAuth",
) {}

/** Local control-channel authentication capability. */
export class MuximodAuthControlService extends Context.Service<MuximodAuthControlService, MuximodAuthControl>()(
  "@muximo/application/MuximodAuthControl",
) {}

/** Services required by authentication use cases. */
export type AuthServices =
  | AuthClockService
  | AuthConnectionService
  | AuthStoreService
  | AuthPairingClaimSinkService
  | AuthCryptoService
  | AuthChallengeStoreService
  | AuthRateLimitStoreService
  | AuthWsTicketStoreService
  | AuthServerIdService;

export const authClockLayer = (clock: AuthClock): Layer.Layer<AuthClockService> =>
  Layer.succeed(AuthClockService, clock);

export const authConnectionLayer = (connections: AuthConnection): Layer.Layer<AuthConnectionService> =>
  Layer.succeed(AuthConnectionService, connections);

export const authStoreLayer = (store: AuthStore): Layer.Layer<AuthStoreService> =>
  Layer.succeed(AuthStoreService, store);

export const authPairingClaimSinkLayer = (sink: AuthPairingClaimSink): Layer.Layer<AuthPairingClaimSinkService> =>
  Layer.succeed(AuthPairingClaimSinkService, sink);

export const authCryptoLayer = (crypto: AuthCrypto): Layer.Layer<AuthCryptoService> =>
  Layer.succeed(AuthCryptoService, crypto);

export const authChallengeStoreLayer = (challenges: AuthChallengeStore): Layer.Layer<AuthChallengeStoreService> =>
  Layer.succeed(AuthChallengeStoreService, challenges);

export const authRateLimitStoreLayer = (rateLimits: AuthRateLimitStore): Layer.Layer<AuthRateLimitStoreService> =>
  Layer.succeed(AuthRateLimitStoreService, rateLimits);

export const authWsTicketStoreLayer = (wsTickets: AuthWsTicketStore): Layer.Layer<AuthWsTicketStoreService> =>
  Layer.succeed(AuthWsTicketStoreService, wsTickets);

export const authServerIdLayer = (serverId: string): Layer.Layer<AuthServerIdService> =>
  Layer.succeed(AuthServerIdService, serverId);

/** Provides the transport-facing authentication implementation. */
export const muximodAuthLayer = (auth: MuximodAuth): Layer.Layer<MuximodAuthService> =>
  Layer.succeed(MuximodAuthService, auth);

/** Provides the local control-channel authentication implementation. */
export const muximodAuthControlLayer = (auth: MuximodAuthControl): Layer.Layer<MuximodAuthControlService> =>
  Layer.succeed(MuximodAuthControlService, auth);

/** Assembles all authentication use-case services from concrete implementations. */
export const authLayer = (dependencies: {
  clock: AuthClock;
  connections: AuthConnection;
  store: AuthStore;
  claimSink: AuthPairingClaimSink;
  crypto: AuthCrypto;
  challenges: AuthChallengeStore;
  rateLimits: AuthRateLimitStore;
  wsTickets: AuthWsTicketStore;
  serverId: string;
}): Layer.Layer<AuthServices> =>
  Layer.mergeAll(
    authClockLayer(dependencies.clock),
    authConnectionLayer(dependencies.connections),
    authStoreLayer(dependencies.store),
    authPairingClaimSinkLayer(dependencies.claimSink),
    authCryptoLayer(dependencies.crypto),
    authChallengeStoreLayer(dependencies.challenges),
    authRateLimitStoreLayer(dependencies.rateLimits),
    authWsTicketStoreLayer(dependencies.wsTickets),
    authServerIdLayer(dependencies.serverId),
  );
