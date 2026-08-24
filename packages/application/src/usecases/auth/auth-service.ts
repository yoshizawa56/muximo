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

  public constructor(private readonly options: AuthServiceOptions) {
    this.serverId = options.serverId;
  }

  public createPairing(overrides: { muximodBaseUrl?: string } = {}): Promise<AuthPairingPayload> {
    return startPairingOp(this.options, overrides);
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
    const session = await this.options.store.findSession(token);
    return session ? contextForSession(this.options.store, session) : undefined;
  }

  public issueWebSocketTicket(context: MuximodAuthContext, endpoint: "terminal"): Promise<WsTicketResponse> {
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
