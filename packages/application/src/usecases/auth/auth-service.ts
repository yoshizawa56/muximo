import type {
  AuthChallengeStorePort,
  AuthCryptoPort,
  AuthRateLimitStorePort,
  AuthStorePort,
  AuthWsTicketStorePort,
  MuximodAuthPort,
  TrackedSocketRegistryPort,
} from "../../ports/auth.js";
import type {
  AuthChallengeResponse,
  AuthDeviceRecord,
  AuthPairingClaimNotification,
  AuthPairingClaimRequest,
  AuthPairingClaimResponse,
  AuthPairingPayload,
  AuthPairingStatus,
  AuthSessionResponse,
  MuximodAuthContext,
  WsTicketResponse,
} from "../../ports/auth-types.js";
import type { MuximodSocket } from "../../ports/socket.js";
import { claimPairing as claimPairingOp } from "./claim-pairing.js";
import { consumeWebSocketTicket as consumeTicketOp } from "./consume-ticket.js";
import { createChallenge as createChallengeOp } from "./create-challenge.js";
import { createAuthSession } from "./create-session.js";
import { contextForSession } from "./device-guard.js";
import { issueWebSocketTicket as issueTicketOp } from "./issue-ticket.js";
import { startPairing as startPairingOp } from "./start-pairing.js";

export type AuthServiceOptions = {
  store: AuthStorePort;
  muximodBaseUrl: string;
  crypto: AuthCryptoPort;
  challenges: AuthChallengeStorePort;
  rateLimits: AuthRateLimitStorePort;
  wsTickets: AuthWsTicketStorePort;
  sockets: TrackedSocketRegistryPort;
  now?: () => Date;
};

/**
 * Transport-facing auth facade. All state lives in the injected flow-store
 * ports; every operation delegates to a single-purpose use case.
 */
export class AuthService implements MuximodAuthPort, AuthControlExtras {
  public readonly serverId: string;
  private pairingClaimListener: ((notification: AuthPairingClaimNotification) => void) | undefined;

  public constructor(private readonly options: AuthServiceOptions) {
    this.serverId = options.store.getServerId();
  }

  public setPairingClaimListener(listener: ((notification: AuthPairingClaimNotification) => void) | undefined): void {
    this.pairingClaimListener = listener;
  }

  public createPairing(overrides: { muximodBaseUrl?: string } = {}): AuthPairingPayload {
    return startPairingOp(this.options, overrides);
  }

  public claimPairing(pairingId: string, request: AuthPairingClaimRequest): AuthPairingClaimResponse {
    return claimPairingOp(
      { ...this.options, serverId: this.serverId, onClaimed: (n) => this.pairingClaimListener?.(n) },
      pairingId,
      request,
    );
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
    return createChallengeOp({ ...this.options, serverId: this.serverId }, deviceId);
  }

  public createSession(input: { deviceId: string; challengeId: string; signature: string }): AuthSessionResponse {
    return createAuthSession({ ...this.options, serverId: this.serverId }, input);
  }

  public authenticateAccessToken(token: string | undefined): MuximodAuthContext | null {
    if (!token) return null;
    const session = this.options.store.findSession(token);
    return session ? contextForSession(this.options.store, session) : null;
  }

  public issueWebSocketTicket(context: MuximodAuthContext, endpoint: "terminal"): WsTicketResponse {
    return issueTicketOp(this.options, context, endpoint);
  }

  public consumeWebSocketTicket(ticket: string | undefined, endpoint: "terminal"): MuximodAuthContext | null {
    return consumeTicketOp(this.options, ticket, endpoint);
  }

  public trackSocket(context: MuximodAuthContext, socket: MuximodSocket): void {
    const expiresAtMs = new Date(context.expiresAt).getTime();
    this.options.sockets.track({
      sessionId: context.sessionId,
      deviceId: context.deviceId,
      socket,
      expiresAtMs,
    });
  }

  public revokeDevice(deviceId: string): void {
    this.options.sockets.closeForDevice(deviceId, 4001, "device revoked");
    this.options.store.revokeDevice(deviceId);
  }

  public listDevices(): AuthDeviceRecord[] {
    return this.options.store.listDevices();
  }
}

export interface AuthControlExtras {
  setPairingClaimListener(listener: ((notification: AuthPairingClaimNotification) => void) | undefined): void;
  approvePairing(pairingId: string): AuthDeviceRecord;
  rejectPairing(pairingId: string): void;
  trackSocket(context: MuximodAuthContext, socket: MuximodSocket): void;
  revokeDevice(deviceId: string): void;
  listDevices(): AuthDeviceRecord[];
}
