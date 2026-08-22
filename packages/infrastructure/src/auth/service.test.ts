import { describe, expect, it } from "vitest";
import {
  hasObserved,
  runScenarioTable,
  type FixtureHandle,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { canonicalPublicJwk, pairingClaimMessage, sessionMessage } from "@muximo/domain";
import { createAgentDatabase, AuthStore } from "../persistence/index.js";
import { AuthService } from "./service.js";

type AuthFixture = {
  database: ReturnType<typeof createAgentDatabase>;
  auth: AuthService;
  keyPair: CryptoKeyPair;
  publicKey: { kty: "EC"; crv: "P-256"; x: string; y: string };
  keyFingerprint: string;
  payload?: ReturnType<AuthService["createPairing"]>;
  claim?: ReturnType<AuthService["claimPairing"]>;
  device?: ReturnType<AuthService["approvePairing"]>;
  challenge?: ReturnType<AuthService["createChallenge"]>;
  session?: ReturnType<AuthService["createSession"]>;
  contextDeviceId: string | null;
  claimStatus: string | null;
  approvedStatus: string | null;
  deviceId: string | null;
  deviceKeyFingerprint: string | null;
  sessionId: string | null;
  ticketSessionId: string | null;
  ticketSecondUse: unknown;
};
type AuthStep =
  | { type: "create-pairing" }
  | { type: "claim" }
  | { type: "approve" }
  | { type: "create-session" }
  | { type: "consume-ticket" };
type AuthContext = Pick<AuthFixture, "keyFingerprint" | "contextDeviceId" | "claimStatus" | "approvedStatus" | "deviceId" | "deviceKeyFingerprint" | "sessionId" | "ticketSessionId" | "ticketSecondUse">;

const authFixture = async (): Promise<FixtureHandle<AuthFixture>> => {
  const database = createAgentDatabase();
  const auth = new AuthService({ store: new AuthStore(database.db, database.sqlite), muximodBaseUrl: "http://127.0.0.1:4317" });
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
    claimStatus: null,
    approvedStatus: null,
    deviceId: null,
    deviceKeyFingerprint: null,
    sessionId: null,
    ticketSessionId: null,
    ticketSecondUse: null,
  };
  return { fixture, cleanup: () => database.close() };
};

const cases = [
  {
    name: "requires a signed claim, host approval, and signed session challenge",
    steps: [
      { type: "create-pairing" },
      { type: "claim" },
      { type: "approve" },
      { type: "create-session" },
      { type: "consume-ticket" },
    ],
    assert: [
      hasObserved<AuthContext, undefined>("claimStatus", "awaiting_approval"),
      hasObserved<AuthContext, undefined>("approvedStatus", "approved"),
      hasObserved<AuthContext, undefined>("ticketSecondUse", null),
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
        fixture.payload = fixture.auth.createPairing();
        continue;
      }
      if (step.type === "claim") {
        const payload = fixture.payload!;
        const clientNonce = "client-nonce-123456";
        const pairingSecretHash = await sha256Hex(payload.pairingSecret);
        const claimSignature = await signEcdsa(fixture.keyPair.privateKey, pairingClaimMessage({ serverId: payload.serverId, pairingId: payload.pairingId, pairingSecretHash, keyFingerprint: fixture.keyFingerprint, clientNonce }));
        fixture.claim = fixture.auth.claimPairing(payload.pairingId, { pairingSecret: payload.pairingSecret, publicKey: fixture.publicKey, deviceName: "Test browser", deviceType: "browser", platform: "test", clientVersion: "test", clientNonce, signature: claimSignature });
        fixture.claimStatus = fixture.auth.pairingStatus(payload.pairingId, fixture.claim.claimToken).status;
        continue;
      }
      if (step.type === "approve") {
        const payload = fixture.payload!;
        fixture.device = fixture.auth.approvePairing(payload.pairingId);
        fixture.deviceId = fixture.device.deviceId;
        fixture.deviceKeyFingerprint = fixture.device.keyFingerprint;
        fixture.approvedStatus = fixture.auth.pairingStatus(payload.pairingId, fixture.claim!.claimToken).status;
        continue;
      }
      if (step.type === "create-session") {
        const device = fixture.device!;
        fixture.challenge = fixture.auth.createChallenge(device.deviceId);
        const challenge = fixture.challenge;
        const signature = await signEcdsa(fixture.keyPair.privateKey, sessionMessage({ serverId: challenge.serverId, deviceId: challenge.deviceId, challengeId: challenge.challengeId, challengeNonce: challenge.nonce, expiresAt: challenge.expiresAt }));
        fixture.session = fixture.auth.createSession({ deviceId: device.deviceId, challengeId: challenge.challengeId, signature });
        fixture.sessionId = fixture.session.sessionId;
        const context = fixture.auth.authenticateAccessToken(fixture.session.accessToken);
        fixture.contextDeviceId = context?.deviceId ?? null;
        continue;
      }
      if (step.type === "consume-ticket") {
        const context = fixture.auth.authenticateAccessToken(fixture.session!.accessToken);
        const ticket = fixture.auth.issueWebSocketTicket(context!, "terminal");
        fixture.ticketSessionId = fixture.auth.consumeWebSocketTicket(ticket.ticket, "terminal")?.sessionId ?? null;
        fixture.ticketSecondUse = fixture.auth.consumeWebSocketTicket(ticket.ticket, "terminal");
      }
    }
  },
  observe: (fixture) => ({ keyFingerprint: fixture.keyFingerprint, contextDeviceId: fixture.contextDeviceId, claimStatus: fixture.claimStatus, approvedStatus: fixture.approvedStatus, deviceId: fixture.deviceId, deviceKeyFingerprint: fixture.deviceKeyFingerprint, sessionId: fixture.sessionId, ticketSessionId: fixture.ticketSessionId, ticketSecondUse: fixture.ticketSecondUse }),
};

describe("muximod device authentication", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

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
