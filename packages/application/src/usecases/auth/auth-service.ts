import type {
  AuthChallengeResponse,
  AuthDeviceRecord,
  AuthPairingClaimNotification,
  AuthPairingClaimRequest,
  AuthPairingClaimResponse,
  AuthPairingPayload,
  AuthPairingStatus,
  AuthSessionRecord,
  AuthSessionResponse,
  MuximodAuthContext,
  WsTicketResponse,
} from "../../models/auth.js";
import type { AuthCryptoPort, AuthStorePort, MuximodAuthPort } from "../../ports/auth.js";
import type { MuximodSocket } from "../../ports/socket.js";
import { AuthStoreError } from "./auth-errors.js";

const PAIRING_TTL_MS = 5 * 60_000;
const CLAIM_TTL_MS = 10 * 60_000;
const CHALLENGE_TTL_MS = 60_000;
const SESSION_TTL_MS = 15 * 60_000;
const WS_TICKET_TTL_MS = 30_000;

export type AuthServiceOptions = {
  store: AuthStorePort;
  muximodBaseUrl: string;
  crypto: AuthCryptoPort;
  now?: () => Date;
};

type PendingChallenge = {
  challengeId: string;
  deviceId: string;
  nonce: string;
  expiresAt: string;
};

type PendingWsTicket = {
  sessionId: string;
  endpoint: "terminal";
  expiresAt: string;
};

type TrackedSockets = {
  deviceId: string;
  sockets: Set<MuximodSocket>;
  expiryTimers: Map<MuximodSocket, ReturnType<typeof setTimeout>>;
};

export class AuthService implements MuximodAuthPort {
  public readonly serverId: string;
  private readonly challenges = new Map<string, PendingChallenge>();
  private readonly challengeWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly wsTickets = new Map<string, PendingWsTicket>();
  private readonly sockets = new Map<string, TrackedSockets>();
  private pairingClaimListener: ((notification: AuthPairingClaimNotification) => void) | undefined;

  public constructor(private readonly options: AuthServiceOptions) {
    this.serverId = options.store.getServerId();
  }

  public setPairingClaimListener(listener: ((notification: AuthPairingClaimNotification) => void) | undefined): void {
    this.pairingClaimListener = listener;
  }

  public createPairing(overrides: { muximodBaseUrl?: string } = {}): AuthPairingPayload {
    const expiresAt = this.future(PAIRING_TTL_MS);
    const pairing = this.options.store.createPairing({
      muximodBaseUrl: overrides.muximodBaseUrl ?? this.options.muximodBaseUrl,
      expiresAt: expiresAt.toISOString(),
      secret: this.options.crypto.randomOpaque(32),
    });
    return {
      v: 2,
      muximodBaseUrl: pairing.muximodBaseUrl,
      serverId: pairing.serverId,
      pairingId: pairing.pairingId,
      pairingSecret: pairing.secret,
      expiresAt: expiresAt.getTime(),
    };
  }

  public claimPairing(pairingId: string, request: AuthPairingClaimRequest): AuthPairingClaimResponse {
    const keyFingerprint = this.options.crypto.fingerprint(request.publicKey);
    const secretHash = this.options.crypto.hashOpaque(request.pairingSecret);
    const message = this.options.crypto.pairingClaimMessage({
      serverId: this.serverId,
      pairingId,
      pairingSecretHash: secretHash,
      keyFingerprint,
      clientNonce: request.clientNonce,
    });
    if (!this.options.crypto.verifyPublicKeySignature(request.publicKey, message, request.signature)) {
      throw new AuthStoreError("claim_signature_invalid", "pairing claim signature is invalid");
    }

    const claimToken = this.options.crypto.randomOpaque(32);
    const claimExpiresAt = this.future(CLAIM_TTL_MS).toISOString();
    const _result = this.options.store.claimPairing({
      pairingId,
      secretHash,
      claimToken,
      claimExpiresAt,
      publicKeyJwk: JSON.stringify(request.publicKey),
      keyFingerprint,
      displayName: request.deviceName,
      deviceType: request.deviceType,
      platform: request.platform ?? null,
      clientVersion: request.clientVersion ?? null,
    });

    this.pairingClaimListener?.({
      pairingId,
      serverId: this.serverId,
      deviceName: request.deviceName,
      deviceType: request.deviceType,
      platform: request.platform ?? null,
      clientVersion: request.clientVersion ?? null,
      keyFingerprint,
      expiresAt: claimExpiresAt,
    });
    return {
      serverId: this.serverId,
      pairingId,
      claimToken,
      status: "awaiting_approval",
      expiresAt: claimExpiresAt,
      keyFingerprint,
    };
  }

  public pairingStatus(pairingId: string, claimToken: string): { status: AuthPairingStatus; deviceId: string | null } {
    return this.options.store.getPairingStatus(pairingId, claimToken);
  }

  public approvePairing(pairingId: string): AuthDeviceRecord {
    return this.options.store.approvePairing(pairingId);
  }

  public rejectPairing(pairingId: string): void {
    this.options.store.rejectPairing(pairingId);
  }

  public createChallenge(deviceId: string): AuthChallengeResponse {
    const device = this.requireActiveDevice(deviceId);
    const now = this.current().getTime();
    const window = this.challengeWindows.get(deviceId);
    if (!window || now - window.startedAt >= 60_000) {
      this.challengeWindows.set(deviceId, { startedAt: now, count: 1 });
    } else {
      if (window.count >= 10)
        throw new AuthStoreError("challenge_rate_limited", "too many authentication challenges requested");
      window.count += 1;
    }
    this.removeExpiredChallenges();
    const challengeId = this.options.crypto.randomOpaque(24);
    const nonce = this.options.crypto.randomOpaque(32);
    const expiresAt = this.future(CHALLENGE_TTL_MS).toISOString();
    this.challenges.set(challengeId, { challengeId, deviceId, nonce, expiresAt });
    return { serverId: this.serverId, deviceId: device.deviceId, challengeId, nonce, expiresAt };
  }

  public createSession(input: { deviceId: string; challengeId: string; signature: string }): AuthSessionResponse {
    const challenge = this.challenges.get(input.challengeId);
    this.challenges.delete(input.challengeId);
    if (!challenge || challenge.deviceId !== input.deviceId || this.isExpired(challenge.expiresAt)) {
      throw new AuthStoreError("challenge_invalid", "authentication challenge is invalid or expired");
    }
    const device = this.requireActiveDevice(input.deviceId);
    const message = this.options.crypto.sessionMessage({
      serverId: this.serverId,
      deviceId: input.deviceId,
      challengeId: challenge.challengeId,
      challengeNonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    });
    if (
      !this.options.crypto.verifyPublicKeySignature(
        this.options.crypto.parsePublicKey(device.publicKeyJwk),
        message,
        input.signature,
      )
    ) {
      throw new AuthStoreError("session_signature_invalid", "session signature is invalid");
    }

    const sessionId = this.options.crypto.randomOpaque(24);
    const accessToken = this.options.crypto.randomOpaque(32);
    const expiresAt = this.future(SESSION_TTL_MS).toISOString();
    this.options.store.createSession({ sessionId, token: accessToken, deviceId: device.deviceId, expiresAt });
    return { serverId: this.serverId, deviceId: device.deviceId, sessionId, accessToken, expiresAt };
  }

  public authenticateAccessToken(token: string | undefined): MuximodAuthContext | null {
    if (!token) return null;
    const session = this.options.store.findSession(token);
    return session ? this.contextForSession(session) : null;
  }

  public issueWebSocketTicket(context: MuximodAuthContext, endpoint: "terminal"): WsTicketResponse {
    const ticket = this.options.crypto.randomOpaque(32);
    const expiresAt = this.future(WS_TICKET_TTL_MS).toISOString();
    this.wsTickets.set(this.options.crypto.hashOpaque(ticket), { sessionId: context.sessionId, endpoint, expiresAt });
    return { ticket, endpoint, expiresAt };
  }

  public consumeWebSocketTicket(ticket: string | undefined, endpoint: "terminal"): MuximodAuthContext | null {
    if (!ticket) return null;
    const ticketHash = this.options.crypto.hashOpaque(ticket);
    const pending = this.wsTickets.get(ticketHash);
    this.wsTickets.delete(ticketHash);
    if (!pending || pending.endpoint !== endpoint || this.isExpired(pending.expiresAt)) return null;
    const session = this.options.store.findSessionById(pending.sessionId);
    return session ? this.contextForSession(session) : null;
  }

  public trackSocket(context: MuximodAuthContext, socket: MuximodSocket): void {
    const tracked = this.sockets.get(context.sessionId) ?? {
      deviceId: context.deviceId,
      sockets: new Set<MuximodSocket>(),
      expiryTimers: new Map<MuximodSocket, ReturnType<typeof setTimeout>>(),
    };
    tracked.sockets.add(socket);
    const remainingMs = Math.max(0, new Date(context.expiresAt).getTime() - this.current().getTime());
    const expiryTimer = setTimeout(() => socket.close(4001, "session expired"), remainingMs);
    (expiryTimer as unknown as { unref?: () => void }).unref?.();
    tracked.expiryTimers.set(socket, expiryTimer);
    this.sockets.set(context.sessionId, tracked);
    let removeCloseListener: () => void = () => undefined;
    removeCloseListener = socket.onClose(() => {
      clearTimeout(expiryTimer);
      tracked.sockets.delete(socket);
      tracked.expiryTimers.delete(socket);
      if (tracked.sockets.size === 0) this.sockets.delete(context.sessionId);
      removeCloseListener();
    });
  }

  public revokeDevice(deviceId: string): void {
    for (const [sessionId, tracked] of this.sockets) {
      if (tracked.deviceId !== deviceId) continue;
      for (const socket of tracked.sockets) socket.close(4001, "device revoked");
      for (const timer of tracked.expiryTimers.values()) clearTimeout(timer);
      this.sockets.delete(sessionId);
    }
    this.options.store.revokeDevice(deviceId);
  }

  public listDevices(): AuthDeviceRecord[] {
    return this.options.store.listDevices();
  }

  private requireActiveDevice(deviceId: string): AuthDeviceRecord {
    const device = this.options.store.findDevice(deviceId);
    if (!device || device.serverId !== this.serverId || device.status !== "active") {
      throw new AuthStoreError("device_inactive", "device is not active");
    }
    return device;
  }

  private contextForSession(session: AuthSessionRecord): MuximodAuthContext | null {
    const device = this.options.store.findDevice(session.deviceId);
    if (device?.status !== "active") return null;
    return { ...session, device };
  }

  private current(): Date {
    return this.options.now?.() ?? new Date();
  }

  private future(milliseconds: number): Date {
    return new Date(this.current().getTime() + milliseconds);
  }

  private isExpired(value: string): boolean {
    return value <= this.current().toISOString();
  }

  private removeExpiredChallenges(): void {
    if (this.challenges.size <= 1_000) return;
    for (const [challengeId, challenge] of this.challenges) {
      if (this.isExpired(challenge.expiresAt)) this.challenges.delete(challengeId);
    }
  }
}
