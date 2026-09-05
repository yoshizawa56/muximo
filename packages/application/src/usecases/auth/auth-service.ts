import { Effect, type Layer } from "effect";
import type { ApplicationEffect } from "../../effect.js";
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
import {
  AuthClockService,
  AuthConnectionService,
  AuthCryptoService,
  type AuthServices,
  AuthStoreService,
  type MuximodAuth,
} from "./auth-services.js";
import { claimPairing as claimPairingOp } from "./claim-pairing.js";
import { consumeWebSocketTicket as consumeTicketOp } from "./consume-ticket.js";
import { createChallenge as createChallengeOp } from "./create-challenge.js";
import { createAuthSession } from "./create-session.js";
import { contextForSession } from "./device-guard.js";
import { issueWebSocketTicket as issueTicketOp } from "./issue-ticket.js";
import { startPairing as startPairingOp } from "./start-pairing.js";

export type AuthServiceOptions = {
  serverId: string;
  layer: Layer.Layer<AuthServices>;
};

/**
 * Transport-facing auth facade. All state lives in the injected flow-store
 * ports; every operation delegates to a single-purpose use case. The class
 * stays a stateful coordinator for in-memory local sessions while the
 * composition root supplies its capability layer.
 */
export class AuthService implements MuximodAuth, AuthControlExtras {
  public readonly serverId: string;
  private readonly localSessions = new Map<string, MuximodAuthContext>();

  public constructor(private readonly options: AuthServiceOptions) {
    this.serverId = options.serverId;
  }

  public createPairing(input: { muximodBaseUrl: string }): ApplicationEffect<AuthPairingPayload> {
    return this.provide(startPairingOp(input));
  }

  /** Issues a short-lived in-memory token after the caller passed the private control-socket boundary. */
  public createLocalSession(): ApplicationEffect<AuthSessionResponse> {
    const serverId = this.serverId;
    const localSessions = this.localSessions;
    return this.provide(
      Effect.gen(function* () {
        const clock = yield* AuthClockService;
        const crypto = yield* AuthCryptoService;
        const now = clock.now();
        const accessToken = crypto.randomOpaque(32);
        const sessionId = crypto.randomOpaque(24);
        const expiresAt = new Date(now.getTime() + 15 * 60_000).toISOString();
        const session: MuximodAuthContext = {
          sessionId,
          serverId,
          deviceId: "local-cli",
          issuedAt: now.toISOString(),
          expiresAt,
        };
        localSessions.set(accessToken, session);
        return {
          serverId,
          deviceId: session.deviceId,
          sessionId,
          accessToken,
          expiresAt,
        };
      }),
    );
  }

  public claimPairing(
    pairingId: string,
    request: AuthPairingClaimRequest,
  ): ApplicationEffect<AuthPairingClaimResponse> {
    return this.provide(claimPairingOp(pairingId, request));
  }

  public pairingStatus(
    pairingId: string,
    claimToken: string,
  ): ApplicationEffect<{ status: AuthPairingStatus; deviceId?: string }> {
    return this.provide(
      Effect.gen(function* () {
        const store = yield* AuthStoreService;
        return yield* store.getPairingStatus(pairingId, claimToken);
      }),
    );
  }

  public approvePairing(pairingId: string): ApplicationEffect<AuthDeviceRecord> {
    return this.provide(
      Effect.gen(function* () {
        const store = yield* AuthStoreService;
        return yield* store.approvePairing(pairingId);
      }),
    );
  }

  public rejectPairing(pairingId: string): ApplicationEffect<void> {
    return this.provide(
      Effect.gen(function* () {
        const store = yield* AuthStoreService;
        return yield* store.rejectPairing(pairingId);
      }),
    );
  }

  public createChallenge(deviceId: string): ApplicationEffect<AuthChallengeResponse> {
    return this.provide(createChallengeOp(deviceId));
  }

  public createSession(input: {
    deviceId: string;
    challengeId: string;
    signature: string;
  }): ApplicationEffect<AuthSessionResponse> {
    return this.provide(createAuthSession(input));
  }

  public authenticateAccessToken(token: string | undefined): ApplicationEffect<MuximodAuthContext | undefined> {
    if (!token) return Effect.succeed(undefined);
    const localSession = this.localSessions.get(token);
    if (localSession) {
      const localSessions = this.localSessions;
      return this.provide(
        Effect.gen(function* () {
          const clock = yield* AuthClockService;
          if (localSession.expiresAt <= clock.now().toISOString()) {
            localSessions.delete(token);
            return undefined;
          }
          return localSession;
        }),
      );
    }
    return this.provide(
      Effect.gen(function* () {
        const store = yield* AuthStoreService;
        const session = yield* store.findSession(token);
        return session ? yield* contextForSession(session) : undefined;
      }),
    );
  }

  public issueWebSocketTicket(context: MuximodAuthContext, endpoint: "terminal"): ApplicationEffect<WsTicketResponse> {
    if (!context.device) {
      return Effect.fail(
        new AuthStoreError("local_session_terminal_forbidden", "local CLI sessions cannot open terminal sockets"),
      );
    }
    return this.provide(issueTicketOp(context, endpoint));
  }

  public consumeWebSocketTicket(
    ticket: string | undefined,
    endpoint: "terminal",
  ): ApplicationEffect<MuximodAuthContext | undefined> {
    return this.provide(consumeTicketOp(ticket, endpoint));
  }

  public revokeDevice(deviceId: string): ApplicationEffect<void> {
    return this.provide(
      Effect.gen(function* () {
        const store = yield* AuthStoreService;
        const connections = yield* AuthConnectionService;
        yield* store.revokeDevice(deviceId);
        yield* connections.disconnectDevice(deviceId);
      }),
    );
  }

  public revokeSession(sessionId: string): ApplicationEffect<void> {
    return this.provide(
      Effect.gen(function* () {
        const store = yield* AuthStoreService;
        const connections = yield* AuthConnectionService;
        yield* store.revokeSession(sessionId);
        yield* connections.disconnectSession(sessionId);
      }),
    );
  }

  public listDevices(): ApplicationEffect<AuthDeviceRecord[]> {
    return this.provide(
      Effect.gen(function* () {
        const store = yield* AuthStoreService;
        return yield* store.listDevices();
      }),
    );
  }

  private provide<A>(effect: Effect.Effect<A, Error, AuthServices>): ApplicationEffect<A> {
    return effect.pipe(Effect.provide(this.options.layer));
  }
}

export interface AuthControlExtras {
  approvePairing(pairingId: string): ApplicationEffect<AuthDeviceRecord>;
  rejectPairing(pairingId: string): ApplicationEffect<void>;
  revokeDevice(deviceId: string): ApplicationEffect<void>;
  revokeSession(sessionId: string): ApplicationEffect<void>;
  listDevices(): ApplicationEffect<AuthDeviceRecord[]>;
}
