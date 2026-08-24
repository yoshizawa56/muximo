import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Authentication tables are bootstrapped for legacy databases by
 * `ensureAuthSchema`. CRUD still uses these Drizzle definitions so database
 * reads and writes do not bypass the repository type boundary.
 */
export const authMetadata = sqliteTable("auth_metadata", {
  id: integer("id").primaryKey(),
  serverId: text("server_id").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const authDevices = sqliteTable(
  "auth_devices",
  {
    deviceId: text("device_id").primaryKey(),
    serverId: text("server_id").notNull(),
    publicKeyJwk: text("public_key_jwk").notNull(),
    keyFingerprint: text("key_fingerprint").notNull().unique(),
    displayName: text("display_name").notNull(),
    deviceType: text("device_type", { enum: ["browser", "native", "cli"] }).notNull(),
    platform: text("platform"),
    clientVersion: text("client_version"),
    status: text("status", { enum: ["active", "revoked"] }).notNull(),
    createdAt: text("created_at").notNull(),
    approvedAt: text("approved_at").notNull(),
    lastSeenAt: text("last_seen_at"),
    revokedAt: text("revoked_at"),
  },
  (table) => ({
    statusIndex: index("auth_devices_status_index").on(table.status),
  }),
);

export const authPairings = sqliteTable(
  "auth_pairings",
  {
    pairingId: text("pairing_id").primaryKey(),
    serverId: text("server_id").notNull(),
    webOrigin: text("web_origin").notNull().default(""),
    muximodBaseUrl: text("muximod_base_url").notNull(),
    secretHash: text("secret_hash").notNull().unique(),
    claimTokenHash: text("claim_token_hash").unique(),
    status: text("status", { enum: ["offered", "awaiting_approval", "approved", "rejected", "expired"] }).notNull(),
    offeredAt: text("offered_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    claimExpiresAt: text("claim_expires_at"),
    claimedAt: text("claimed_at"),
    approvedAt: text("approved_at"),
    pendingPublicKeyJwk: text("pending_public_key_jwk"),
    pendingFingerprint: text("pending_fingerprint"),
    pendingDisplayName: text("pending_display_name"),
    pendingDeviceType: text("pending_device_type", { enum: ["browser", "native", "cli"] }),
    pendingPlatform: text("pending_platform"),
    pendingClientVersion: text("pending_client_version"),
    deviceId: text("device_id"),
  },
  (table) => ({
    statusIndex: index("auth_pairings_status_index").on(table.status),
  }),
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    sessionId: text("session_id").primaryKey(),
    serverId: text("server_id").notNull(),
    deviceId: text("device_id").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    lastUsedAt: text("last_used_at"),
  },
  (table) => ({
    deviceIndex: index("auth_sessions_device_index").on(table.deviceId),
    expiryIndex: index("auth_sessions_expiry_index").on(table.expiresAt),
  }),
);
