import type {
  AuthChallengeStorePort,
  AuthConnectionPort,
  AuthCryptoPort,
  AuthPairingClaimSinkPort,
  AuthRateLimitStorePort,
  AuthStorePort,
  AuthWsTicketStorePort,
  Clock,
  MuximodAuthPort,
} from "../../ports/auth.js";
import type {
  AuthChallengeResponse,
  AuthDeviceRecord,
  AuthPairingClaimRequest,
  AuthPairingClaimResponse,
  AuthPairingPayload,
  AuthPairingStatus,
  AuthSessionResponse,
  MuximodAuthContext,
  WsTicketResponse,
} from "../../ports/auth-types.js";
import { AuthStoreError } from "./auth-errors.js";
import { claimPairing as claimPairingOp } from "./claim-pairing.js";
import { consumeWebSocketTicket as consumeTicketOp } from "./consume-ticket.js";
import { createChallenge as createChallengeOp } from "./create-challenge.js";
import { createAuthSession } from "./create-session.js";
import { contextForSession } from "./device-guard.js";
import { issueWebSocketTicket as issueTicketOp } from "./issue-ticket.js";
import { startPairing as startPairingOp } from "./start-pairing.js";

export type AuthServiceOptions = {
  store: AuthStorePort;
  serverId: string;
  muximodBaseUrl: string;
  crypto: AuthCryptoPort;
  clock: Clock;
  claimSink: AuthPairingClaimSinkPort;
  challenges: AuthChallengeStorePort;
  rateLimits: AuthRateLimitStorePort;
  wsTickets: AuthWsTicketStorePort;
  connections: AuthConnectionPort;
};

/**
 * Transport-facing auth facade. All state lives in the injected flow-store
 * ports; every operation delegates to a single-purpose use case.
 */
export class AuthService implements MuximodAuthPort, AuthControlExtras {
  public readonly serverId: string;
  private readonly localSessions = new Map<string, MuximodAuthContext>();

  public constructor(private readonly options: AuthServiceOptions) {
    this.serverId = options.serverId;
  }

  public createPairing(overrides: { muximodBaseUrl?: string } = {}): Promise<AuthPairingPayload> {
    return startPairingOp(this.options, overrides);
  }

  /** Issues a short-lived in-memory token after the caller passed the private control-socket boundary. */
  public async createLocalSession(): Promise<AuthSessionResponse> {
    const now = this.options.clock.now();
    const accessToken = this.options.crypto.randomOpaque(32);
    const sessionId = this.options.crypto.randomOpaque(24);
    const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
    const session: MuximodAuthContext = {
      sessionId,
      serverId: this.serverId,
      deviceId: "local-cli",
      issuedAt: now.toISOString(),
      expiresAt,
    };
    this.localSessions.set(accessToken, session);
    return {
      serverId: this.serverId,
      deviceId: session.deviceId,
      sessionId,
      accessToken,
      expiresAt,
    };
  }

  public claimPairing(pairingId: string, request: AuthPairingClaimRequest): Promise<AuthPairingClaimResponse> {
    return claimPairingOp({ ...this.options, serverId: this.serverId }, pairingId, request);
  }

  public pairingStatus(
    pairingId: string,
    claimToken: string,
  ): Promise<{ status: AuthPairingStatus; deviceId?: string }> {
    return this.options.store.getPairingStatus(pairingId, claimToken);
  }

  public approvePairing(pairingId: string): Promise<AuthDeviceRecord> {
    return this.options.store.approvePairing(pairingId);
  }

  public rejectPairing(pairingId: string): Promise<void> {
    return this.options.store.rejectPairing(pairingId);
  }

  public createChallenge(deviceId: string): Promise<AuthChallengeResponse> {
    return createChallengeOp({ ...this.options, serverId: this.serverId }, deviceId);
  }

  public createSession(input: {
    deviceId: string;
    challengeId: string;
    signature: string;
  }): Promise<AuthSessionResponse> {
    return createAuthSession({ ...this.options, serverId: this.serverId }, input);
  }

  public async authenticateAccessToken(token: string | undefined): Promise<MuximodAuthContext | undefined> {
    if (!token) return undefined;
    const localSession = this.localSessions.get(token);
    if (localSession) {
      if (localSession.expiresAt <= this.options.clock.now().toISOString()) {
        this.localSessions.delete(token);
        return undefined;
      }
      return localSession;
    }
    const session = await this.options.store.findSession(token);
    return session ? contextForSession(this.options.store, session) : undefined;
  }

  public issueWebSocketTicket(context: MuximodAuthContext, endpoint: "terminal"): Promise<WsTicketResponse> {
    if (!context.device) {
      throw new AuthStoreError("local_session_terminal_forbidden", "local CLI sessions cannot open terminal sockets");
    }
    return issueTicketOp(this.options, context, endpoint);
  }

  public consumeWebSocketTicket(
    ticket: string | undefined,
    endpoint: "terminal",
  ): Promise<MuximodAuthContext | undefined> {
    return consumeTicketOp(this.options, ticket, endpoint);
  }

  public async revokeDevice(deviceId: string): Promise<void> {
    await this.options.store.revokeDevice(deviceId);
    await this.options.connections.disconnectDevice(deviceId);
  }

  public async revokeSession(sessionId: string): Promise<void> {
    await this.options.store.revokeSession(sessionId);
    await this.options.connections.disconnectSession(sessionId);
  }

  public listDevices(): Promise<AuthDeviceRecord[]> {
    return this.options.store.listDevices();
  }
}

export interface AuthControlExtras {
  approvePairing(pairingId: string): Promise<AuthDeviceRecord>;
  rejectPairing(pairingId: string): Promise<void>;
  revokeDevice(deviceId: string): Promise<void>;
  revokeSession(sessionId: string): Promise<void>;
  listDevices(): Promise<AuthDeviceRecord[]>;
}
