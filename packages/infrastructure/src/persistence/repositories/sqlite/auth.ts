// AuthStore is a SQLite repository; the application port owns its interface.
import { createHash, randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { AuthStoreError, type AuthDeviceRecord, type AuthPairingRecord, type AuthSessionRecord, type AuthStorePort, type AuthDeviceType, type ClaimPairingInput, type ClaimPairingResult, type CreatePairingInput, type CreatePairingResult, type AuthPairingStatus, type AuthDeviceStatus } from "@muximo/application";
import type { AgentDrizzleDatabase } from "../../database-types.js";
import { authDevices, authMetadata, authPairings, authSessions } from "../../auth-schema.js";
import { ambientDatabase, currentSqliteTransaction } from "../../transaction-context.js";
import { runSqliteTransaction } from "../../transaction.js";

export type {
  AuthDeviceRecord,
  AuthDeviceStatus,
  AuthDeviceType,
  AuthPairingRecord,
  AuthPairingStatus,
  AuthSessionRecord,
  ClaimPairingInput,
  ClaimPairingResult,
  CreatePairingInput,
  CreatePairingResult,
} from "@muximo/application";

/**
 * Drizzle-backed authentication repository. The root SQLite connection is
 * used only when no ambient transaction exists; repository calls inside an
 * application transaction automatically use its dedicated Drizzle client.
 */
export class AuthStore implements AuthStorePort {
  public constructor(
    private readonly rootDatabase: AgentDrizzleDatabase,
    private readonly rootSqlite: Database,
  ) {}

  public getServerId(): string {
    const existing = this.db().select({ serverId: authMetadata.serverId }).from(authMetadata).where(eq(authMetadata.id, 1)).get();
    if (existing?.serverId) return existing.serverId;

    const serverId = randomOpaque(16);
    const now = timestamp();
    this.runTransaction(() => {
      const current = this.db().select({ serverId: authMetadata.serverId }).from(authMetadata).where(eq(authMetadata.id, 1)).get();
      if (!current?.serverId) {
        this.db().insert(authMetadata).values({ id: 1, serverId, createdAt: now }).run();
      }
    });

    const row = this.db().select({ serverId: authMetadata.serverId }).from(authMetadata).where(eq(authMetadata.id, 1)).get();
    if (!row?.serverId) throw new AuthStoreError("auth_metadata_missing", "muximod authentication metadata could not be initialized");
    return row.serverId;
  }

  public createPairing(input: CreatePairingInput): CreatePairingResult {
    const serverId = this.getServerId();
    const pairingId = randomOpaque(16);
    this.db().insert(authPairings).values({
      pairingId,
      serverId,
      // Keep the legacy NOT NULL column populated for databases created by
      // v1. It is no longer part of the pairing model or returned to clients.
      webOrigin: "",
      muximodBaseUrl: input.muximodBaseUrl,
      secretHash: hashOpaque(input.secret),
      status: "offered",
      offeredAt: timestamp(),
      expiresAt: input.expiresAt,
    }).run();
    return {
      pairingId,
      serverId,
      secret: input.secret,
      muximodBaseUrl: input.muximodBaseUrl,
      expiresAt: input.expiresAt,
    };
  }

  public findPairing(pairingId: string): AuthPairingRecord | null {
    const row = this.db().select().from(authPairings).where(eq(authPairings.pairingId, pairingId)).get();
    if (!row) return null;
    const pairing = toPairingRecord(row);
    if (isExpired(pairing.expiresAt) && pairing.status === "offered") {
      this.db().update(authPairings)
        .set({ status: "expired" })
        .where(and(eq(authPairings.pairingId, pairingId), eq(authPairings.status, "offered")))
        .run();
      return { ...pairing, status: "expired" };
    }
    if (pairing.claimExpiresAt && isExpired(pairing.claimExpiresAt) && pairing.status === "awaiting_approval") {
      this.db().update(authPairings)
        .set({ status: "expired" })
        .where(and(eq(authPairings.pairingId, pairingId), eq(authPairings.status, "awaiting_approval")))
        .run();
      return { ...pairing, status: "expired" };
    }
    return pairing;
  }

  public claimPairing(input: ClaimPairingInput): ClaimPairingResult {
    const claim = this.runTransaction(() => {
      const row = this.db().select().from(authPairings).where(eq(authPairings.pairingId, input.pairingId)).get();
      if (!row) throw new AuthStoreError("pairing_not_found", "pairing was not found");
      const pairing = toPairingRecord(row);
      if (pairing.serverId !== this.getServerId()) throw new AuthStoreError("wrong_server", "pairing belongs to another authentication realm");
      if (pairing.status !== "offered") throw new AuthStoreError("pairing_unavailable", "pairing is no longer available");
      if (isExpired(pairing.expiresAt)) {
        this.db().update(authPairings).set({ status: "expired" }).where(eq(authPairings.pairingId, input.pairingId)).run();
        throw new AuthStoreError("pairing_expired", "pairing has expired");
      }
      if (!timingSafeEqualText(row.secretHash, input.secretHash)) throw new AuthStoreError("pairing_invalid", "pairing secret is invalid");

      const updated = this.db().update(authPairings)
        .set({
          claimTokenHash: hashOpaque(input.claimToken),
          status: "awaiting_approval",
          claimExpiresAt: input.claimExpiresAt,
          claimedAt: timestamp(),
          pendingPublicKeyJwk: input.publicKeyJwk,
          pendingFingerprint: input.keyFingerprint,
          pendingDisplayName: input.displayName,
          pendingDeviceType: input.deviceType,
          pendingPlatform: input.platform,
          pendingClientVersion: input.clientVersion,
        })
        .where(and(eq(authPairings.pairingId, input.pairingId), eq(authPairings.status, "offered")))
        .returning({ pairingId: authPairings.pairingId })
        .all();
      if (updated.length === 0) throw new AuthStoreError("pairing_race", "pairing was claimed by another client");

      const updatedRow = this.db().select().from(authPairings).where(eq(authPairings.pairingId, input.pairingId)).get();
      if (!updatedRow || updatedRow.status !== "awaiting_approval") throw new AuthStoreError("pairing_race", "pairing was claimed by another client");
      return toPairingRecord(updatedRow);
    });

    return { pairing: claim, claimToken: input.claimToken };
  }

  public getPairingStatus(pairingId: string, claimToken: string): { status: AuthPairingStatus; deviceId: string | null } {
    const pairing = this.findPairing(pairingId);
    if (!pairing) throw new AuthStoreError("pairing_not_found", "pairing was not found");
    const row = this.db().select({ claimTokenHash: authPairings.claimTokenHash, claimExpiresAt: authPairings.claimExpiresAt })
      .from(authPairings)
      .where(eq(authPairings.pairingId, pairingId))
      .get();
    if (!row?.claimTokenHash || !timingSafeEqualText(row.claimTokenHash, hashOpaque(claimToken))) {
      throw new AuthStoreError("claim_token_invalid", "claim token is invalid");
    }
    if (!row.claimExpiresAt || isExpired(row.claimExpiresAt)) throw new AuthStoreError("claim_token_expired", "claim token has expired");
    return { status: pairing.status, deviceId: pairing.deviceId };
  }

  public approvePairing(pairingId: string): AuthDeviceRecord {
    return this.runTransaction(() => {
      const row = this.db().select().from(authPairings).where(eq(authPairings.pairingId, pairingId)).get();
      if (!row) throw new AuthStoreError("pairing_not_found", "pairing was not found");
      const pairing = toPairingRecord(row);
      if (pairing.status !== "awaiting_approval" || !pairing.pendingPublicKeyJwk || !pairing.pendingFingerprint) {
        throw new AuthStoreError("pairing_not_awaiting_approval", "pairing is not awaiting approval");
      }
      if (!pairing.claimExpiresAt || isExpired(pairing.claimExpiresAt)) {
        this.db().update(authPairings).set({ status: "expired" }).where(eq(authPairings.pairingId, pairingId)).run();
        throw new AuthStoreError("pairing_expired", "pairing approval has expired");
      }

      const deviceId = `device-${randomOpaque(16)}`;
      const approvedAt = timestamp();
      this.db().insert(authDevices).values({
        deviceId,
        serverId: pairing.serverId,
        publicKeyJwk: pairing.pendingPublicKeyJwk,
        keyFingerprint: pairing.pendingFingerprint,
        displayName: pairing.pendingDisplayName ?? "Unnamed device",
        deviceType: pairing.pendingDeviceType ?? "browser",
        platform: pairing.pendingPlatform,
        clientVersion: pairing.pendingClientVersion,
        status: "active",
        createdAt: approvedAt,
        approvedAt,
      }).run();
      this.db().update(authPairings)
        .set({ status: "approved", approvedAt, deviceId })
        .where(eq(authPairings.pairingId, pairingId))
        .run();
      const inserted = this.db().select().from(authDevices).where(eq(authDevices.deviceId, deviceId)).get();
      if (!inserted) throw new AuthStoreError("device_registration_failed", "device registration failed");
      return toDeviceRecord(inserted);
    });
  }

  public rejectPairing(pairingId: string): void {
    const result = this.db().update(authPairings)
      .set({ status: "rejected" })
      .where(and(eq(authPairings.pairingId, pairingId), inArray(authPairings.status, ["offered", "awaiting_approval"])))
      .returning({ pairingId: authPairings.pairingId })
      .all();
    if (result.length === 0) throw new AuthStoreError("pairing_not_rejectable", "pairing is no longer pending");
  }

  public findDevice(deviceId: string): AuthDeviceRecord | null {
    const row = this.db().select().from(authDevices).where(eq(authDevices.deviceId, deviceId)).get();
    return row ? toDeviceRecord(row) : null;
  }

  public createSession(input: { sessionId: string; token: string; deviceId: string; expiresAt: string }): AuthSessionRecord {
    const device = this.findDevice(input.deviceId);
    if (!device || device.status !== "active") throw new AuthStoreError("device_inactive", "device is not active");
    const issuedAt = timestamp();
    this.db().insert(authSessions).values({
      sessionId: input.sessionId,
      serverId: device.serverId,
      deviceId: input.deviceId,
      tokenHash: hashOpaque(input.token),
      issuedAt,
      expiresAt: input.expiresAt,
    }).run();
    return { sessionId: input.sessionId, serverId: device.serverId, deviceId: input.deviceId, issuedAt, expiresAt: input.expiresAt, revokedAt: null };
  }

  public findSession(token: string): AuthSessionRecord | null {
    const now = timestamp();
    const row = this.db()
      .select({
        sessionId: authSessions.sessionId,
        serverId: authSessions.serverId,
        deviceId: authSessions.deviceId,
        issuedAt: authSessions.issuedAt,
        expiresAt: authSessions.expiresAt,
        revokedAt: authSessions.revokedAt,
        deviceStatus: authDevices.status,
      })
      .from(authSessions)
      .innerJoin(authDevices, eq(authDevices.deviceId, authSessions.deviceId))
      .where(eq(authSessions.tokenHash, hashOpaque(token)))
      .get();
    if (!row || row.deviceStatus !== "active" || row.revokedAt || row.expiresAt <= now) return null;
    this.db().update(authSessions).set({ lastUsedAt: now }).where(eq(authSessions.sessionId, row.sessionId)).run();
    this.db().update(authDevices).set({ lastSeenAt: now }).where(eq(authDevices.deviceId, row.deviceId)).run();
    return toSessionRecord(row);
  }

  public findSessionById(sessionId: string): AuthSessionRecord | null {
    const row = this.db().select({
      sessionId: authSessions.sessionId,
      serverId: authSessions.serverId,
      deviceId: authSessions.deviceId,
      issuedAt: authSessions.issuedAt,
      expiresAt: authSessions.expiresAt,
      revokedAt: authSessions.revokedAt,
    }).from(authSessions).where(eq(authSessions.sessionId, sessionId)).get();
    if (!row || row.revokedAt || row.expiresAt <= timestamp()) return null;
    const device = this.findDevice(row.deviceId);
    if (!device || device.status !== "active") return null;
    return toSessionRecord(row);
  }

  public revokeSession(sessionId: string): void {
    this.db().update(authSessions)
      .set({ revokedAt: timestamp() })
      .where(and(eq(authSessions.sessionId, sessionId), isNull(authSessions.revokedAt)))
      .run();
  }

  public revokeDevice(deviceId: string): void {
    const now = timestamp();
    this.runTransaction(() => {
      this.db().update(authDevices)
        .set({ status: "revoked", revokedAt: now })
        .where(and(eq(authDevices.deviceId, deviceId), eq(authDevices.status, "active")))
        .run();
      this.db().update(authSessions)
        .set({ revokedAt: now })
        .where(and(eq(authSessions.deviceId, deviceId), isNull(authSessions.revokedAt)))
        .run();
    });
  }

  public listDevices(): AuthDeviceRecord[] {
    return this.db().select().from(authDevices).orderBy(asc(authDevices.createdAt)).all().map(toDeviceRecord);
  }

  private db(): AgentDrizzleDatabase {
    return ambientDatabase(this.rootDatabase);
  }

  private runTransaction<Result>(operation: () => Result): Result {
    if (currentSqliteTransaction()) return operation();
    return runSqliteTransaction(this.rootSqlite, operation);
  }
}

type AuthPairingRow = typeof authPairings.$inferSelect;
type AuthDeviceRow = typeof authDevices.$inferSelect;

function toPairingRecord(row: AuthPairingRow): AuthPairingRecord {
  return {
    pairingId: row.pairingId,
    serverId: row.serverId,
    muximodBaseUrl: row.muximodBaseUrl,
    status: row.status,
    offeredAt: row.offeredAt,
    expiresAt: row.expiresAt,
    claimExpiresAt: row.claimExpiresAt,
    claimedAt: row.claimedAt,
    approvedAt: row.approvedAt,
    pendingPublicKeyJwk: row.pendingPublicKeyJwk,
    pendingFingerprint: row.pendingFingerprint,
    pendingDisplayName: row.pendingDisplayName,
    pendingDeviceType: row.pendingDeviceType,
    pendingPlatform: row.pendingPlatform,
    pendingClientVersion: row.pendingClientVersion,
    deviceId: row.deviceId,
  };
}

function toDeviceRecord(row: AuthDeviceRow): AuthDeviceRecord {
  return {
    deviceId: row.deviceId,
    serverId: row.serverId,
    publicKeyJwk: row.publicKeyJwk,
    keyFingerprint: row.keyFingerprint,
    displayName: row.displayName,
    deviceType: row.deviceType,
    platform: row.platform,
    clientVersion: row.clientVersion,
    status: row.status,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt,
  };
}

function toSessionRecord(row: {
  sessionId: string;
  serverId: string;
  deviceId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}): AuthSessionRecord {
  return {
    sessionId: row.sessionId,
    serverId: row.serverId,
    deviceId: row.deviceId,
    issuedAt: row.issuedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt ?? null,
  };
}

function randomOpaque(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function hashOpaque(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function timingSafeEqualText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return result === 0;
}

function timestamp(): string {
  return new Date().toISOString();
}

function isExpired(value: string): boolean {
  return value <= timestamp();
}
