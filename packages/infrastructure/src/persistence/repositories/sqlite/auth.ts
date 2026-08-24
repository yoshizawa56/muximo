// AuthStore is a SQLite repository; the application port owns its interface.

import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
  type AuthDeviceRecord,
  type AuthPairingRecord,
  type AuthPairingStatus,
  type AuthSessionRecord,
  AuthStoreError,
  type AuthStorePort,
  type ClaimPairingInput,
  type ClaimPairingResult,
  type CreatePairingInput,
  type CreatePairingResult,
  type PublicKeyJwk,
} from "@muximo/application";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { authDevices, authMetadata, authPairings, authSessions } from "../../auth-schema.js";
import type { AgentDrizzleDatabase } from "../../database-types.js";
import { runSqliteTransaction } from "../../transaction.js";
import {
  ambientDatabase,
  assertSqliteTransactionIdentity,
  currentSqliteTransaction,
} from "../../transaction-context.js";

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
 * JSON and SQL NULL values are converted to application records here.
 */
export class AuthStore implements AuthStorePort {
  public readonly serverId: string;

  public constructor(
    private readonly rootDatabase: AgentDrizzleDatabase,
    private readonly rootSqlite: Database,
  ) {
    this.serverId = this.initializeServerId();
  }

  public async createPairing(input: CreatePairingInput): Promise<CreatePairingResult> {
    const pairingId = randomOpaque(16);
    this.db()
      .insert(authPairings)
      .values({
        pairingId,
        serverId: this.serverId,
        // Keep the legacy NOT NULL column populated for databases created by
        // v1. It is no longer part of the pairing model or returned to clients.
        webOrigin: "",
        muximodBaseUrl: input.muximodBaseUrl,
        secretHash: hashOpaque(input.secret),
        status: "offered",
        offeredAt: timestamp(),
        expiresAt: input.expiresAt,
      })
      .run();
    return {
      pairingId,
      serverId: this.serverId,
      secret: input.secret,
      muximodBaseUrl: input.muximodBaseUrl,
      expiresAt: input.expiresAt,
    };
  }

  public async findPairing(pairingId: string): Promise<AuthPairingRecord | undefined> {
    return this.findPairingRecord(pairingId);
  }

  public async claimPairing(input: ClaimPairingInput): Promise<ClaimPairingResult> {
    const claim = this.runTransaction(() => {
      const row = this.db().select().from(authPairings).where(eq(authPairings.pairingId, input.pairingId)).get();
      if (!row) throw new AuthStoreError("pairing_not_found", "pairing was not found");
      const pairing = toPairingRecord(row);
      if (pairing.serverId !== this.serverId)
        throw new AuthStoreError("wrong_server", "pairing belongs to another authentication realm");
      if (pairing.status !== "offered")
        throw new AuthStoreError("pairing_unavailable", "pairing is no longer available");
      if (isExpired(pairing.expiresAt)) {
        this.db()
          .update(authPairings)
          .set({ status: "expired" })
          .where(eq(authPairings.pairingId, input.pairingId))
          .run();
        throw new AuthStoreError("pairing_expired", "pairing has expired");
      }
      if (!timingSafeEqualText(row.secretHash, input.secretHash))
        throw new AuthStoreError("pairing_invalid", "pairing secret is invalid");

      const updated = this.db()
        .update(authPairings)
        .set({
          claimTokenHash: hashOpaque(input.claimToken),
          status: "awaiting_approval",
          claimExpiresAt: input.claimExpiresAt,
          claimedAt: timestamp(),
          pendingPublicKeyJwk: JSON.stringify(input.publicKey),
          pendingFingerprint: input.keyFingerprint,
          pendingDisplayName: input.displayName,
          pendingDeviceType: input.deviceType,
          pendingPlatform: input.platform ?? null,
          pendingClientVersion: input.clientVersion ?? null,
        })
        .where(and(eq(authPairings.pairingId, input.pairingId), eq(authPairings.status, "offered")))
        .returning({ pairingId: authPairings.pairingId })
        .all();
      if (updated.length === 0) throw new AuthStoreError("pairing_race", "pairing was claimed by another client");

      const updatedRow = this.db().select().from(authPairings).where(eq(authPairings.pairingId, input.pairingId)).get();
      if (updatedRow?.status !== "awaiting_approval")
        throw new AuthStoreError("pairing_race", "pairing was claimed by another client");
      return toPairingRecord(updatedRow);
    });

    return { pairing: claim, claimToken: input.claimToken };
  }

  public async getPairingStatus(
    pairingId: string,
    claimToken: string,
  ): Promise<{ status: AuthPairingStatus; deviceId?: string }> {
    const pairing = this.findPairingRecord(pairingId);
    if (!pairing) throw new AuthStoreError("pairing_not_found", "pairing was not found");
    const row = this.db()
      .select({ claimTokenHash: authPairings.claimTokenHash, claimExpiresAt: authPairings.claimExpiresAt })
      .from(authPairings)
      .where(eq(authPairings.pairingId, pairingId))
      .get();
    if (!row?.claimTokenHash || !timingSafeEqualText(row.claimTokenHash, hashOpaque(claimToken))) {
      throw new AuthStoreError("claim_token_invalid", "claim token is invalid");
    }
    if (!row.claimExpiresAt || isExpired(row.claimExpiresAt))
      throw new AuthStoreError("claim_token_expired", "claim token has expired");
    return { status: pairing.status, ...(pairing.deviceId === undefined ? {} : { deviceId: pairing.deviceId }) };
  }

  public async approvePairing(pairingId: string): Promise<AuthDeviceRecord> {
    return this.runTransaction(() => {
      const row = this.db().select().from(authPairings).where(eq(authPairings.pairingId, pairingId)).get();
      if (!row) throw new AuthStoreError("pairing_not_found", "pairing was not found");
      const pairing = toPairingRecord(row);
      if (pairing.status !== "awaiting_approval" || !pairing.pendingPublicKey || !pairing.pendingFingerprint) {
        throw new AuthStoreError("pairing_not_awaiting_approval", "pairing is not awaiting approval");
      }
      if (!pairing.claimExpiresAt || isExpired(pairing.claimExpiresAt)) {
        this.db().update(authPairings).set({ status: "expired" }).where(eq(authPairings.pairingId, pairingId)).run();
        throw new AuthStoreError("pairing_expired", "pairing approval has expired");
      }

      const deviceId = `device-${randomOpaque(16)}`;
      const approvedAt = timestamp();
      this.db()
        .insert(authDevices)
        .values({
          deviceId,
          serverId: pairing.serverId,
          publicKeyJwk: JSON.stringify(pairing.pendingPublicKey),
          keyFingerprint: pairing.pendingFingerprint,
          displayName: pairing.pendingDisplayName ?? "Unnamed device",
          deviceType: pairing.pendingDeviceType ?? "browser",
          platform: pairing.pendingPlatform ?? null,
          clientVersion: pairing.pendingClientVersion ?? null,
          status: "active",
          createdAt: approvedAt,
          approvedAt,
        })
        .run();
      this.db()
        .update(authPairings)
        .set({ status: "approved", approvedAt, deviceId })
        .where(eq(authPairings.pairingId, pairingId))
        .run();
      const inserted = this.db().select().from(authDevices).where(eq(authDevices.deviceId, deviceId)).get();
      if (!inserted) throw new AuthStoreError("device_registration_failed", "device registration failed");
      return toDeviceRecord(inserted);
    });
  }

  public async rejectPairing(pairingId: string): Promise<void> {
    const result = this.db()
      .update(authPairings)
      .set({ status: "rejected" })
      .where(and(eq(authPairings.pairingId, pairingId), inArray(authPairings.status, ["offered", "awaiting_approval"])))
      .returning({ pairingId: authPairings.pairingId })
      .all();
    if (result.length === 0) throw new AuthStoreError("pairing_not_rejectable", "pairing is no longer pending");
  }

  public async findDevice(deviceId: string): Promise<AuthDeviceRecord | undefined> {
    return this.findDeviceRecord(deviceId);
  }

  public async createSession(input: {
    sessionId: string;
    token: string;
    deviceId: string;
    expiresAt: string;
  }): Promise<AuthSessionRecord> {
    const device = this.findDeviceRecord(input.deviceId);
    if (device?.status !== "active") throw new AuthStoreError("device_inactive", "device is not active");
    const issuedAt = timestamp();
    this.db()
      .insert(authSessions)
      .values({
        sessionId: input.sessionId,
        serverId: device.serverId,
        deviceId: input.deviceId,
        tokenHash: hashOpaque(input.token),
        issuedAt,
        expiresAt: input.expiresAt,
      })
      .run();
    return {
      sessionId: input.sessionId,
      serverId: device.serverId,
      deviceId: input.deviceId,
      issuedAt,
      expiresAt: input.expiresAt,
    };
  }

  public async findSession(token: string): Promise<AuthSessionRecord | undefined> {
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
    if (row?.deviceStatus !== "active" || row.revokedAt || row.expiresAt <= now) return undefined;
    this.db().update(authSessions).set({ lastUsedAt: now }).where(eq(authSessions.sessionId, row.sessionId)).run();
    this.db().update(authDevices).set({ lastSeenAt: now }).where(eq(authDevices.deviceId, row.deviceId)).run();
    return toSessionRecord(row);
  }

  public async findSessionById(sessionId: string): Promise<AuthSessionRecord | undefined> {
    const row = this.db()
      .select({
        sessionId: authSessions.sessionId,
        serverId: authSessions.serverId,
        deviceId: authSessions.deviceId,
        issuedAt: authSessions.issuedAt,
        expiresAt: authSessions.expiresAt,
        revokedAt: authSessions.revokedAt,
      })
      .from(authSessions)
      .where(eq(authSessions.sessionId, sessionId))
      .get();
    if (!row || row.revokedAt || row.expiresAt <= timestamp()) return undefined;
    const device = this.findDeviceRecord(row.deviceId);
    if (device?.status !== "active") return undefined;
    return toSessionRecord(row);
  }

  public async revokeSession(sessionId: string): Promise<void> {
    this.db()
      .update(authSessions)
      .set({ revokedAt: timestamp() })
      .where(and(eq(authSessions.sessionId, sessionId), isNull(authSessions.revokedAt)))
      .run();
  }

  public async revokeDevice(deviceId: string): Promise<void> {
    const now = timestamp();
    this.runTransaction(() => {
      this.db()
        .update(authDevices)
        .set({ status: "revoked", revokedAt: now })
        .where(and(eq(authDevices.deviceId, deviceId), eq(authDevices.status, "active")))
        .run();
      this.db()
        .update(authSessions)
        .set({ revokedAt: now })
        .where(and(eq(authSessions.deviceId, deviceId), isNull(authSessions.revokedAt)))
        .run();
    });
  }

  public async listDevices(): Promise<AuthDeviceRecord[]> {
    return this.db().select().from(authDevices).orderBy(asc(authDevices.createdAt)).all().map(toDeviceRecord);
  }

  private initializeServerId(): string {
    const existing = this.rootDatabase
      .select({ serverId: authMetadata.serverId })
      .from(authMetadata)
      .where(eq(authMetadata.id, 1))
      .get();
    if (existing?.serverId) return existing.serverId;

    const serverId = randomOpaque(16);
    const now = timestamp();
    runSqliteTransaction(this.rootSqlite, () => {
      const current = this.rootDatabase
        .select({ serverId: authMetadata.serverId })
        .from(authMetadata)
        .where(eq(authMetadata.id, 1))
        .get();
      if (!current?.serverId) this.rootDatabase.insert(authMetadata).values({ id: 1, serverId, createdAt: now }).run();
    });

    const row = this.rootDatabase
      .select({ serverId: authMetadata.serverId })
      .from(authMetadata)
      .where(eq(authMetadata.id, 1))
      .get();
    if (!row?.serverId)
      throw new AuthStoreError("auth_metadata_missing", "muximod authentication metadata could not be initialized");
    return row.serverId;
  }

  private findPairingRecord(pairingId: string): AuthPairingRecord | undefined {
    const row = this.db().select().from(authPairings).where(eq(authPairings.pairingId, pairingId)).get();
    if (!row) return undefined;
    const pairing = toPairingRecord(row);
    const now = timestamp();
    if (pairing.expiresAt <= now && pairing.status === "offered") {
      this.db()
        .update(authPairings)
        .set({ status: "expired" })
        .where(and(eq(authPairings.pairingId, pairingId), eq(authPairings.status, "offered")))
        .run();
      return { ...pairing, status: "expired" };
    }
    if (pairing.claimExpiresAt && pairing.claimExpiresAt <= now && pairing.status === "awaiting_approval") {
      this.db()
        .update(authPairings)
        .set({ status: "expired" })
        .where(and(eq(authPairings.pairingId, pairingId), eq(authPairings.status, "awaiting_approval")))
        .run();
      return { ...pairing, status: "expired" };
    }
    return pairing;
  }

  private findDeviceRecord(deviceId: string): AuthDeviceRecord | undefined {
    const row = this.db().select().from(authDevices).where(eq(authDevices.deviceId, deviceId)).get();
    return row ? toDeviceRecord(row) : undefined;
  }

  private db(): AgentDrizzleDatabase {
    return ambientDatabase(this.rootDatabase);
  }

  private runTransaction<Result>(operation: () => Result): Result {
    const current = currentSqliteTransaction();
    if (current) {
      assertSqliteTransactionIdentity(current, this.rootDatabase, this.rootSqlite);
      return operation();
    }
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
    ...(row.claimExpiresAt === null ? {} : { claimExpiresAt: row.claimExpiresAt }),
    ...(row.claimedAt === null ? {} : { claimedAt: row.claimedAt }),
    ...(row.approvedAt === null ? {} : { approvedAt: row.approvedAt }),
    ...(row.pendingPublicKeyJwk === null ? {} : { pendingPublicKey: parseStoredPublicKey(row.pendingPublicKeyJwk) }),
    ...(row.pendingFingerprint === null ? {} : { pendingFingerprint: row.pendingFingerprint }),
    ...(row.pendingDisplayName === null ? {} : { pendingDisplayName: row.pendingDisplayName }),
    ...(row.pendingDeviceType === null ? {} : { pendingDeviceType: row.pendingDeviceType }),
    ...(row.pendingPlatform === null ? {} : { pendingPlatform: row.pendingPlatform }),
    ...(row.pendingClientVersion === null ? {} : { pendingClientVersion: row.pendingClientVersion }),
    ...(row.deviceId === null ? {} : { deviceId: row.deviceId }),
  };
}

function toDeviceRecord(row: AuthDeviceRow): AuthDeviceRecord {
  return {
    deviceId: row.deviceId,
    serverId: row.serverId,
    publicKey: parseStoredPublicKey(row.publicKeyJwk),
    keyFingerprint: row.keyFingerprint,
    displayName: row.displayName,
    deviceType: row.deviceType,
    ...(row.platform === null ? {} : { platform: row.platform }),
    ...(row.clientVersion === null ? {} : { clientVersion: row.clientVersion }),
    status: row.status,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt,
    ...(row.lastSeenAt === null ? {} : { lastSeenAt: row.lastSeenAt }),
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
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
    ...(row.revokedAt === null ? {} : { revokedAt: row.revokedAt }),
  };
}

function parseStoredPublicKey(value: string): PublicKeyJwk {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new AuthStoreError("device_key_invalid", "stored device public key is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AuthStoreError("device_key_invalid", "stored device public key is invalid");
  }
  const record = parsed as Record<string, unknown>;
  if (
    record.kty !== "EC" ||
    record.crv !== "P-256" ||
    typeof record.x !== "string" ||
    typeof record.y !== "string" ||
    !isBase64Url(record.x) ||
    !isBase64Url(record.y)
  ) {
    throw new AuthStoreError("device_key_invalid", "stored device public key is invalid");
  }
  return { kty: "EC", crv: "P-256", x: record.x, y: record.y };
}

function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
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
