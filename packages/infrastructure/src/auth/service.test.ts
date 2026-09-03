import {
  type ApplicationEffect,
  type AuthChallengeResponse,
  type AuthDeviceRecord,
  type AuthPairingClaimResponse,
  type AuthPairingPayload,
  AuthService,
  type AuthSessionResponse,
  AuthStoreError,
  type AuthStorePort,
} from "@muximo/application";
import { canonicalPublicJwk, pairingClaimMessage, sessionMessage } from "@muximo/domain";
import {
  type FixtureHandle,
  hasError,
  hasNoError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  resolveMaybePromise,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AuthStore, createAgentDatabase, createMigrationSchemaSynchronizer } from "../persistence/index.js";
import { nodeAuthCrypto } from "./crypto.js";
import { MemoryAuthChallengeStore, MemoryAuthRateLimitStore, MemoryAuthWsTicketStore } from "./flow-store-memory.js";

type AuthFixture = {
  database: ReturnType<typeof createAgentDatabase>;
  auth: AuthService;
  keyPair: CryptoKeyPair;
  publicKey: { kty: "EC"; crv: "P-256"; x: string; y: string };
  keyFingerprint: string;
  payload?: AuthPairingPayload;
  claim?: AuthPairingClaimResponse;
  device?: AuthDeviceRecord;
  challenge?: AuthChallengeResponse;
  session?: AuthSessionResponse;
  localSession?: AuthSessionResponse;
  contextDeviceId: string | null;
  localContextSessionId: string | null;
  localContextDeviceId: string | null;
  localTicketError: string | null;
  claimStatus: string | null;
  approvedStatus: string | null;
  deviceId: string | null;
  deviceKeyFingerprint: string | null;
  sessionId: string | null;
  ticketSessionId: string | null;
  ticketSecondUse: unknown;
  disconnectDeviceCalls: string[];
  disconnectSessionCalls: string[];
};
type AuthStep =
  | { type: "create-pairing" }
  | { type: "claim" }
  | { type: "approve" }
  | { type: "create-session" }
  | { type: "consume-ticket" }
  | { type: "revoke-device" }
  | { type: "revoke-session" };
type AuthContext = Pick<
  AuthFixture,
  | "keyFingerprint"
  | "contextDeviceId"
  | "claimStatus"
  | "approvedStatus"
  | "deviceId"
  | "deviceKeyFingerprint"
  | "sessionId"
  | "ticketSessionId"
  | "ticketSecondUse"
  | "disconnectDeviceCalls"
  | "disconnectSessionCalls"
>;

const authFixture = async (): Promise<FixtureHandle<AuthFixture>> => {
  const database = createAgentDatabase(":memory:", { schemaSynchronizer: createMigrationSchemaSynchronizer() });
  const store = new AuthStore(database.db, database.sqlite);
  const disconnectDeviceCalls: string[] = [];
  const disconnectSessionCalls: string[] = [];
  const auth = new AuthService({
    store,
    serverId: store.serverId,
    crypto: nodeAuthCrypto,
    clock: { now: () => new Date("2099-08-15T00:00:00.000Z") },
    claimSink: { publish: () => Effect.succeed(undefined) },
    challenges: new MemoryAuthChallengeStore(),
    rateLimits: new MemoryAuthRateLimitStore(),
    wsTickets: new MemoryAuthWsTicketStore(),
    connections: {
      disconnectDevice: (deviceId) =>
        Effect.sync(() => {
          disconnectDeviceCalls.push(deviceId);
        }),
      disconnectSession: (sessionId) =>
        Effect.sync(() => {
          disconnectSessionCalls.push(sessionId);
        }),
    },
  });
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const exported = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const publicKey = { kty: "EC" as const, crv: "P-256" as const, x: exported.x!, y: exported.y! };
  const keyFingerprint = await publicKeyFingerprint(publicKey);
  const fixture: AuthFixture = {
    database,
    auth,
    keyPair,
    publicKey,
    keyFingerprint,
    contextDeviceId: null,
    localContextSessionId: null,
    localContextDeviceId: null,
    localTicketError: null,
    claimStatus: null,
    approvedStatus: null,
    deviceId: null,
    deviceKeyFingerprint: null,
    sessionId: null,
    ticketSessionId: null,
    ticketSecondUse: null,
    disconnectDeviceCalls,
    disconnectSessionCalls,
  };
  return { fixture, cleanup: () => database.close() };
};

const cases = [
  {
    name: "requires authentication proofs and disconnects revoked device sessions",
    steps: [
      { type: "create-pairing" },
      { type: "claim" },
      { type: "approve" },
      { type: "create-session" },
      { type: "consume-ticket" },
      { type: "revoke-session" },
      { type: "revoke-device" },
    ],
    assert: [
      hasObserved<AuthContext, undefined>("claimStatus", "awaiting_approval"),
      hasObserved<AuthContext, undefined>("approvedStatus", "approved"),
      hasObserved<AuthContext, undefined>("ticketSecondUse", undefined),
      {
        name: "disconnects the revoked authenticated identifiers",
        check: (context) => {
          if (!context.deviceId || !context.sessionId) throw new Error("authenticated identifiers were not observed");
          expect(context.disconnectDeviceCalls).toEqual([context.deviceId]);
          expect(context.disconnectSessionCalls).toEqual([context.sessionId]);
        },
      },
      {
        name: "binds the approved key to the authenticated device",
        check: (ctx) => {
          if (ctx.deviceKeyFingerprint === null) throw new Error("approved device fingerprint was not observed");
          if (ctx.contextDeviceId === null) throw new Error("authenticated device id was not observed");
          if (ctx.deviceId === null) throw new Error("approved device id was not observed");
          if (ctx.sessionId === null) throw new Error("created session id was not observed");
          expect(ctx.deviceKeyFingerprint).toBe(ctx.keyFingerprint);
          expect(ctx.contextDeviceId).toBe(ctx.deviceId);
          expect(ctx.ticketSessionId).toBe(ctx.sessionId);
        },
      },
    ],
  },
] satisfies readonly ScenarioCase<"default", AuthStep, undefined, AuthContext>[];

const table: ScenarioTable<AuthFixture, "default", AuthStep, undefined, AuthContext> = {
  defaultFixture: authFixture,
  cases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "create-pairing") {
        fixture.payload = await resolveMaybePromise(
          fixture.auth.createPairing({ muximodBaseUrl: "http://127.0.0.1:4317" }),
        );
        continue;
      }
      if (step.type === "claim") {
        const payload = fixture.payload!;
        const clientNonce = "client-nonce-123456";
        const pairingSecretHash = await sha256Hex(payload.pairingSecret);
        const claimSignature = await signEcdsa(
          fixture.keyPair.privateKey,
          pairingClaimMessage({
            serverId: payload.serverId,
            pairingId: payload.pairingId,
            pairingSecretHash,
            keyFingerprint: fixture.keyFingerprint,
            clientNonce,
          }),
        );
        fixture.claim = await resolveMaybePromise(
          fixture.auth.claimPairing(payload.pairingId, {
            pairingSecret: payload.pairingSecret,
            publicKey: fixture.publicKey,
            deviceName: "Test browser",
            deviceType: "browser",
            platform: "test",
            clientVersion: "test",
            clientNonce,
            signature: claimSignature,
          }),
        );
        fixture.claimStatus = (
          await resolveMaybePromise(fixture.auth.pairingStatus(payload.pairingId, fixture.claim.claimToken))
        ).status;
        continue;
      }
      if (step.type === "approve") {
        const payload = fixture.payload!;
        fixture.device = await resolveMaybePromise(fixture.auth.approvePairing(payload.pairingId));
        fixture.deviceId = fixture.device.deviceId;
        fixture.deviceKeyFingerprint = fixture.device.keyFingerprint;
        fixture.approvedStatus = (
          await resolveMaybePromise(fixture.auth.pairingStatus(payload.pairingId, fixture.claim!.claimToken))
        ).status;
        continue;
      }
      if (step.type === "create-session") {
        const device = fixture.device!;
        fixture.challenge = await resolveMaybePromise(fixture.auth.createChallenge(device.deviceId));
        const challenge = fixture.challenge;
        const signature = await signEcdsa(
          fixture.keyPair.privateKey,
          sessionMessage({
            serverId: challenge.serverId,
            deviceId: challenge.deviceId,
            challengeId: challenge.challengeId,
            challengeNonce: challenge.nonce,
            expiresAt: challenge.expiresAt,
          }),
        );
        fixture.session = await resolveMaybePromise(
          fixture.auth.createSession({
            deviceId: device.deviceId,
            challengeId: challenge.challengeId,
            signature,
          }),
        );
        fixture.sessionId = fixture.session.sessionId;
        const context = await resolveMaybePromise(fixture.auth.authenticateAccessToken(fixture.session.accessToken));
        fixture.contextDeviceId = context?.deviceId ?? null;
        continue;
      }
      if (step.type === "consume-ticket") {
        const context = await resolveMaybePromise(fixture.auth.authenticateAccessToken(fixture.session!.accessToken));
        const ticket = await resolveMaybePromise(fixture.auth.issueWebSocketTicket(context!, "terminal"));
        fixture.ticketSessionId =
          (await resolveMaybePromise(fixture.auth.consumeWebSocketTicket(ticket.ticket, "terminal")))?.sessionId ??
          null;
        fixture.ticketSecondUse = await resolveMaybePromise(
          fixture.auth.consumeWebSocketTicket(ticket.ticket, "terminal"),
        );
        continue;
      }
      if (step.type === "revoke-session") {
        await resolveMaybePromise(fixture.auth.revokeSession(fixture.sessionId!));
        continue;
      }
      if (step.type === "revoke-device") {
        await resolveMaybePromise(fixture.auth.revokeDevice(fixture.deviceId!));
      }
    }
  },
  observe: (fixture) => ({
    keyFingerprint: fixture.keyFingerprint,
    contextDeviceId: fixture.contextDeviceId,
    claimStatus: fixture.claimStatus,
    approvedStatus: fixture.approvedStatus,
    deviceId: fixture.deviceId,
    deviceKeyFingerprint: fixture.deviceKeyFingerprint,
    sessionId: fixture.sessionId,
    ticketSessionId: fixture.ticketSessionId,
    ticketSecondUse: fixture.ticketSecondUse,
    disconnectDeviceCalls: [...fixture.disconnectDeviceCalls],
    disconnectSessionCalls: [...fixture.disconnectSessionCalls],
  }),
};

describe("muximod device authentication", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

type LocalAuthStep =
  | { type: "create-local-session" }
  | { type: "authenticate-local-session" }
  | { type: "issue-local-ticket" };
type LocalAuthContext = {
  localContextSessionId: string | null;
  localContextDeviceId: string | null;
  localTicketError: string | null;
};

const localAuthCases = [
  {
    name: "allows local CLI sessions to call the API but not open terminal sockets",
    steps: [{ type: "create-local-session" }, { type: "authenticate-local-session" }, { type: "issue-local-ticket" }],
    assert: [
      hasObserved<LocalAuthContext, undefined>("localContextSessionId", expect.any(String)),
      hasObserved<LocalAuthContext, undefined>("localContextDeviceId", "local-cli"),
      hasObserved<LocalAuthContext, undefined>("localTicketError", "local_session_terminal_forbidden"),
    ],
  },
] satisfies readonly ScenarioCase<"default", LocalAuthStep, undefined, LocalAuthContext>[];

const localAuthTable: ScenarioTable<AuthFixture, "default", LocalAuthStep, undefined, LocalAuthContext> = {
  defaultFixture: authFixture,
  cases: localAuthCases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "create-local-session") {
        fixture.localSession = await resolveMaybePromise(fixture.auth.createLocalSession());
        continue;
      }
      if (step.type === "authenticate-local-session") {
        const session = fixture.localSession;
        if (!session) throw new Error("local session was not created");
        const context = await resolveMaybePromise(fixture.auth.authenticateAccessToken(session.accessToken));
        fixture.localContextSessionId = context?.sessionId ?? null;
        fixture.localContextDeviceId = context?.deviceId ?? null;
        continue;
      }
      const session = fixture.localSession;
      if (!session) throw new Error("local session was not created");
      const context = await resolveMaybePromise(fixture.auth.authenticateAccessToken(session.accessToken));
      if (!context) throw new Error("local session could not be authenticated");
      try {
        await resolveMaybePromise(fixture.auth.issueWebSocketTicket(context, "terminal"));
      } catch (error) {
        if (!(error instanceof AuthStoreError)) throw error;
        fixture.localTicketError = error.code;
      }
    }
  },
  observe: (fixture) => ({
    localContextSessionId: fixture.localContextSessionId,
    localContextDeviceId: fixture.localContextDeviceId,
    localTicketError: fixture.localTicketError,
  }),
};

describe("muximod local CLI authentication", () => {
  runScenarioTable(it as unknown as TestRegistrar, localAuthTable);
});

type RevokeTarget = "device" | "session";
type RevokeFixtureKey = "store-failure";
type RevokeState = { credentialActive: boolean; connectionActive: boolean };
type RevokeFixture = {
  auth: AuthService;
  events: string[];
  state: RevokeState;
};
type RevokeInput = { target: RevokeTarget };
type RevokeContext = {
  events: readonly string[];
  credentialActive: boolean;
  connectionActive: boolean;
};

const createRevokeFixture = (storeFails: boolean): FixtureHandle<RevokeFixture> => {
  const events: string[] = [];
  const state: RevokeState = { credentialActive: true, connectionActive: true };
  const auth = new AuthService({
    store: createRevokeStore(events, state, storeFails),
    serverId: "server-1",
    crypto: nodeAuthCrypto,
    clock: { now: () => new Date("2099-08-15T00:00:00.000Z") },
    claimSink: { publish: () => Effect.succeed(undefined) },
    challenges: new MemoryAuthChallengeStore(),
    rateLimits: new MemoryAuthRateLimitStore(),
    wsTickets: new MemoryAuthWsTicketStore(),
    connections: {
      disconnectDevice: (deviceId) => Effect.sync(() => disconnectConnection(events, state, "device", deviceId)),
      disconnectSession: (sessionId) => Effect.sync(() => disconnectConnection(events, state, "session", sessionId)),
    },
  });
  return { fixture: { auth, events, state } };
};

const revokeCases = [
  {
    name: "commits device revocation before awaiting connection disconnection",
    input: { target: "device" },
    assert: [
      hasNoError<RevokeContext, void>(),
      hasObserved<RevokeContext, void>("events", [
        "store:device:device-1:started",
        "store:device:device-1:committed",
        "connection:device:device-1:started",
        "connection:device:device-1:disconnected",
      ]),
      hasObserved<RevokeContext, void>("credentialActive", false),
      hasObserved<RevokeContext, void>("connectionActive", false),
    ],
  },
  {
    name: "commits session revocation before awaiting connection disconnection",
    input: { target: "session" },
    assert: [
      hasNoError<RevokeContext, void>(),
      hasObserved<RevokeContext, void>("events", [
        "store:session:session-1:started",
        "store:session:session-1:committed",
        "connection:session:session-1:started",
        "connection:session:session-1:disconnected",
      ]),
      hasObserved<RevokeContext, void>("credentialActive", false),
      hasObserved<RevokeContext, void>("connectionActive", false),
    ],
  },
  {
    name: "keeps the device credential and connection active when persistence fails",
    fixture: "store-failure",
    input: { target: "device" },
    assert: [
      hasError<RevokeContext, void>({ message: "auth persistence failed" }),
      hasObserved<RevokeContext, void>("events", ["store:device:device-1:started", "store:device:device-1:failed"]),
      hasObserved<RevokeContext, void>("credentialActive", true),
      hasObserved<RevokeContext, void>("connectionActive", true),
    ],
  },
  {
    name: "keeps the session credential and connection active when persistence fails",
    fixture: "store-failure",
    input: { target: "session" },
    assert: [
      hasError<RevokeContext, void>({ message: "auth persistence failed" }),
      hasObserved<RevokeContext, void>("events", ["store:session:session-1:started", "store:session:session-1:failed"]),
      hasObserved<RevokeContext, void>("credentialActive", true),
      hasObserved<RevokeContext, void>("connectionActive", true),
    ],
  },
] satisfies readonly OperationCase<RevokeFixtureKey, RevokeInput, void, RevokeContext>[];

const revokeTable: OperationTable<RevokeFixture, RevokeFixtureKey, RevokeInput, void, RevokeContext> = {
  defaultFixture: () => createRevokeFixture(false),
  fixtures: { "store-failure": () => createRevokeFixture(true) },
  cases: revokeCases,
  execute: (fixture, input) => {
    if (input.target === "device") return fixture.auth.revokeDevice("device-1");
    return fixture.auth.revokeSession("session-1");
  },
  observe: (fixture) => ({
    events: [...fixture.events],
    credentialActive: fixture.state.credentialActive,
    connectionActive: fixture.state.connectionActive,
  }),
};

describe("authentication revocation ordering", () => {
  runOperationTable(it as unknown as TestRegistrar, revokeTable);
});

function createRevokeStore(events: string[], state: RevokeState, storeFails: boolean): AuthStorePort {
  const unused = (): ApplicationEffect<never> => Effect.fail(new Error("unused authentication store operation"));
  const persist = (target: RevokeTarget, id: string): ApplicationEffect<void> =>
    Effect.sync(() => {
      events.push(`store:${target}:${id}:started`);
      if (storeFails) {
        events.push(`store:${target}:${id}:failed`);
        throw new Error("auth persistence failed");
      }
      state.credentialActive = false;
      events.push(`store:${target}:${id}:committed`);
    });
  return {
    createPairing: unused,
    findPairing: unused,
    claimPairing: unused,
    getPairingStatus: unused,
    approvePairing: unused,
    rejectPairing: unused,
    findDevice: unused,
    createSession: unused,
    findSession: unused,
    findSessionById: unused,
    revokeSession: (sessionId) => persist("session", sessionId),
    revokeDevice: (deviceId) => persist("device", deviceId),
    listDevices: unused,
  };
}

function disconnectConnection(events: string[], state: RevokeState, target: RevokeTarget, id: string): void {
  events.push(`connection:${target}:${id}:started`);
  state.connectionActive = false;
  events.push(`connection:${target}:${id}:disconnected`);
}

async function publicKeyFingerprint(publicKey: AuthFixture["publicKey"]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalPublicJwk(publicKey)));
  return Buffer.from(digest).toString("base64url");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signEcdsa(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(message),
  );
  return Buffer.from(signature).toString("base64url");
}
