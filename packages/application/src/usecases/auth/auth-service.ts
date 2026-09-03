import { Effect } from "effect";
import type { ApplicationEffect } from "../../effect.js";
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
 * ports; every operation delegates to a single-purpose use case. The class
 * stays a stateful coordinator (in-memory local sessions) holding Effect
 * ports via constructor injection.
 */
export class AuthService implements MuximodAuthPort, AuthControlExtras {
  public readonly serverId: string;
  private readonly localSessions = new Map<string, MuximodAuthContext>();

  public constructor(private readonly options: AuthServiceOptions) {
    this.serverId = options.serverId;
  }

  public createPairing(input: { muximodBaseUrl: string }): ApplicationEffect<AuthPairingPayload> {
    return startPairingOp(this.options, input);
  }

  /** Issues a short-lived in-memory token after the caller passed the private control-socket boundary. */
  public createLocalSession(): ApplicationEffect<AuthSessionResponse> {
    return Effect.sync(() => {
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
    });
  }

  public claimPairing(
    pairingId: string,
    request: AuthPairingClaimRequest,
  ): ApplicationEffect<AuthPairingClaimResponse> {
    return claimPairingOp({ ...this.options, serverId: this.serverId }, pairingId, request);
  }

  public pairingStatus(
    pairingId: string,
    claimToken: string,
  ): ApplicationEffect<{ status: AuthPairingStatus; deviceId?: string }> {
    return this.options.store.getPairingStatus(pairingId, claimToken);
  }

  public approvePairing(pairingId: string): ApplicationEffect<AuthDeviceRecord> {
    return this.options.store.approvePairing(pairingId);
  }

  public rejectPairing(pairingId: string): ApplicationEffect<void> {
    return this.options.store.rejectPairing(pairingId);
  }

  public createChallenge(deviceId: string): ApplicationEffect<AuthChallengeResponse> {
    return createChallengeOp({ ...this.options, serverId: this.serverId }, deviceId);
  }

  public createSession(input: {
    deviceId: string;
    challengeId: string;
    signature: string;
  }): ApplicationEffect<AuthSessionResponse> {
    return createAuthSession({ ...this.options, serverId: this.serverId }, input);
  }

  public authenticateAccessToken(token: string | undefined): ApplicationEffect<MuximodAuthContext | undefined> {
    if (!token) return Effect.succeed(undefined);
    const localSession = this.localSessions.get(token);
    if (localSession) {
      if (localSession.expiresAt <= this.options.clock.now().toISOString()) {
        this.localSessions.delete(token);
        return Effect.succeed(undefined);
      }
      return Effect.succeed(localSession);
    }
    return this.options.store
      .findSession(token)
      .pipe(
        Effect.flatMap((session) =>
          session ? contextForSession(this.options.store, session) : Effect.succeed(undefined),
        ),
      );
  }

  public issueWebSocketTicket(context: MuximodAuthContext, endpoint: "terminal"): ApplicationEffect<WsTicketResponse> {
    if (!context.device) {
      return Effect.fail(
        new AuthStoreError("local_session_terminal_forbidden", "local CLI sessions cannot open terminal sockets"),
      );
    }
    return issueTicketOp(this.options, context, endpoint);
  }

  public consumeWebSocketTicket(
    ticket: string | undefined,
    endpoint: "terminal",
  ): ApplicationEffect<MuximodAuthContext | undefined> {
    return consumeTicketOp(this.options, ticket, endpoint);
  }

  public revokeDevice(deviceId: string): ApplicationEffect<void> {
    const options = this.options;
    return Effect.gen(function* () {
      yield* options.store.revokeDevice(deviceId);
      yield* options.connections.disconnectDevice(deviceId);
    });
  }

  public revokeSession(sessionId: string): ApplicationEffect<void> {
    const options = this.options;
    return Effect.gen(function* () {
      yield* options.store.revokeSession(sessionId);
      yield* options.connections.disconnectSession(sessionId);
    });
  }

  public listDevices(): ApplicationEffect<AuthDeviceRecord[]> {
    return this.options.store.listDevices();
  }
}

export interface AuthControlExtras {
  approvePairing(pairingId: string): ApplicationEffect<AuthDeviceRecord>;
  rejectPairing(pairingId: string): ApplicationEffect<void>;
  revokeDevice(deviceId: string): ApplicationEffect<void>;
  revokeSession(sessionId: string): ApplicationEffect<void>;
  listDevices(): ApplicationEffect<AuthDeviceRecord[]>;
}
