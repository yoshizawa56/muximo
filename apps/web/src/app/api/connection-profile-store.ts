import { createBrowserMuximodAuth } from "./browser-auth";
import { createServeConnection, type MuximodConnection } from "./muximod-client.js";

export type BrowserConnectionProfile = {
  id: string;
  name: string;
  muximodBaseUrl: string;
  serverId: string;
  updatedAt: string;
};

export class BrowserConnectionProfileError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BrowserConnectionProfileError";
    if (cause !== undefined) Object.defineProperty(this, "cause", { configurable: true, value: cause });
  }
}

const storageKey = "muximo.connection-profiles.v2";
const legacyStorageKey = "muximo.connection-profile.v1";
/** Keeps the RPC link and browser auth coordinator shared across view models. */
const connectionCache = new Map<string, MuximodConnection>();

export function readBrowserConnectionProfiles(storage: Storage | undefined = getStorage()): BrowserConnectionProfile[] {
  if (!storage) return [];

  const raw = storage.getItem(storageKey);
  if (raw) {
    try {
      return parseProfiles(JSON.parse(raw));
    } catch {
      storage.removeItem(storageKey);
    }
  }

  return migrateLegacyProfile(storage);
}

export function selectBrowserConnectionProfile(
  profileId?: string,
  storage: Storage | undefined = getStorage(),
): BrowserConnectionProfile | null {
  const profiles = readBrowserConnectionProfiles(storage);
  if (!profileId) return profiles[0] ?? null;
  return profiles.find((profile) => profile.id === profileId) ?? null;
}

export function saveBrowserConnectionProfile(
  input: Pick<BrowserConnectionProfile, "name" | "muximodBaseUrl" | "serverId">,
  storage: Storage | undefined = getStorage(),
): BrowserConnectionProfile {
  const profiles = readBrowserConnectionProfiles(storage);
  const muximodBaseUrl = normalizeMuximodBaseUrl(input.muximodBaseUrl);
  const id = input.serverId.trim();
  if (!id) throw new BrowserConnectionProfileError("connection profile serverId is required");

  const previous = profiles.find((profile) => profile.id === id);
  if (previous && previous.muximodBaseUrl !== muximodBaseUrl) connectionCache.delete(previous.muximodBaseUrl);

  const profile: BrowserConnectionProfile = {
    id,
    name: normalizeProfileName(input.name, muximodBaseUrl),
    muximodBaseUrl,
    serverId: id,
    updatedAt: new Date().toISOString(),
  };
  parseProfile(profile);
  const nextProfiles = previous
    ? profiles.map((candidate) => (candidate.id === id ? profile : candidate))
    : [...profiles, profile];
  writeProfiles(storage, nextProfiles);
  return profile;
}

export function renameBrowserConnectionProfile(
  profileId: string,
  name: string,
  storage: Storage | undefined = getStorage(),
): BrowserConnectionProfile {
  const profiles = readBrowserConnectionProfiles(storage);
  const previous = profiles.find((profile) => profile.id === profileId);
  if (!previous) throw new BrowserConnectionProfileError("connection profile was not found");

  const profile: BrowserConnectionProfile = {
    ...previous,
    name: normalizeProfileName(name, previous.muximodBaseUrl, false),
    updatedAt: new Date().toISOString(),
  };
  parseProfile(profile);
  writeProfiles(
    storage,
    profiles.map((candidate) => (candidate.id === profileId ? profile : candidate)),
  );
  return profile;
}

export function removeBrowserConnectionProfile(profileId: string, storage: Storage | undefined = getStorage()): void {
  const profiles = readBrowserConnectionProfiles(storage);
  const previous = profiles.find((profile) => profile.id === profileId);
  if (!previous) return;
  connectionCache.delete(previous.muximodBaseUrl);
  writeProfiles(
    storage,
    profiles.filter((profile) => profile.id !== profileId),
  );
}

export function connectionForProfile(profile: BrowserConnectionProfile | null): MuximodConnection | undefined {
  if (!profile) return undefined;
  const muximodBaseUrl = normalizeMuximodBaseUrl(profile.muximodBaseUrl);
  const cached = connectionCache.get(muximodBaseUrl);
  if (cached) return cached;
  const connection = createServeConnection(muximodBaseUrl);
  connection.auth = createBrowserMuximodAuth(connection);
  connectionCache.set(muximodBaseUrl, connection);
  return connection;
}

export function normalizeMuximodBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("muximod URL must use https:// (http:// is allowed only for local development)");
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function defaultConnectionProfileName(muximodBaseUrl: string): string {
  return new URL(normalizeMuximodBaseUrl(muximodBaseUrl)).host;
}

function writeProfiles(storage: Storage | undefined, profiles: readonly BrowserConnectionProfile[]): void {
  if (!storage) return;
  if (profiles.length === 0) {
    storage.removeItem(storageKey);
    storage.removeItem(legacyStorageKey);
    return;
  }
  storage.setItem(storageKey, JSON.stringify(profiles));
  storage.removeItem(legacyStorageKey);
}

function migrateLegacyProfile(storage: Storage): BrowserConnectionProfile[] {
  const raw = storage.getItem(legacyStorageKey);
  if (!raw) return [];
  try {
    const legacy = parseLegacyProfile(JSON.parse(raw));
    if (!legacy.serverId) throw new BrowserConnectionProfileError("legacy connection profile has no serverId");
    const profile: BrowserConnectionProfile = {
      id: legacy.serverId,
      name: legacy.name,
      muximodBaseUrl: legacy.muximodBaseUrl,
      serverId: legacy.serverId,
      updatedAt: legacy.updatedAt,
    };
    parseProfile(profile);
    writeProfiles(storage, [profile]);
    return [profile];
  } catch {
    storage.removeItem(legacyStorageKey);
    return [];
  }
}

function parseProfiles(value: unknown): BrowserConnectionProfile[] {
  if (!Array.isArray(value)) throw new BrowserConnectionProfileError("stored connection profiles must be an array");
  const profiles = value.map(parseProfile);
  if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
    throw new BrowserConnectionProfileError("stored connection profiles contain duplicate ids");
  }
  return profiles;
}

function parseProfile(value: unknown): BrowserConnectionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserConnectionProfileError("stored connection profile has an invalid shape");
  }
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set(["id", "name", "muximodBaseUrl", "serverId", "updatedAt"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    throw new BrowserConnectionProfileError("stored connection profile contains unknown fields");
  }
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    candidate.id !== candidate.id.trim() ||
    typeof candidate.name !== "string" ||
    candidate.name.length === 0 ||
    candidate.name !== candidate.name.trim() ||
    typeof candidate.muximodBaseUrl !== "string" ||
    typeof candidate.serverId !== "string" ||
    candidate.serverId.length === 0 ||
    candidate.serverId !== candidate.serverId.trim() ||
    candidate.id !== candidate.serverId ||
    typeof candidate.updatedAt !== "string" ||
    !isIsoTimestamp(candidate.updatedAt)
  ) {
    throw new BrowserConnectionProfileError("stored connection profile has an invalid shape");
  }
  let muximodBaseUrl: string;
  try {
    muximodBaseUrl = normalizeMuximodBaseUrl(candidate.muximodBaseUrl);
  } catch (error) {
    throw new BrowserConnectionProfileError("stored connection profile has an invalid muximod URL", error);
  }
  if (muximodBaseUrl !== candidate.muximodBaseUrl) {
    throw new BrowserConnectionProfileError("stored connection profile has a non-canonical muximod URL");
  }
  validateProfileName(candidate.name);
  return {
    id: candidate.id,
    name: candidate.name,
    muximodBaseUrl,
    serverId: candidate.serverId,
    updatedAt: candidate.updatedAt,
  };
}

type LegacyBrowserConnectionProfile = {
  id: "default";
  name: string;
  muximodBaseUrl: string;
  serverId?: string;
  updatedAt: string;
};

function parseLegacyProfile(value: unknown): LegacyBrowserConnectionProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserConnectionProfileError("legacy connection profile has an invalid shape");
  }
  const candidate = value as Record<string, unknown>;
  const allowedKeys = new Set(["id", "name", "muximodBaseUrl", "serverId", "updatedAt"]);
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) {
    throw new BrowserConnectionProfileError("legacy connection profile contains unknown fields");
  }
  if (
    candidate.id !== "default" ||
    typeof candidate.name !== "string" ||
    typeof candidate.muximodBaseUrl !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    !isIsoTimestamp(candidate.updatedAt)
  ) {
    throw new BrowserConnectionProfileError("legacy connection profile has an invalid shape");
  }
  const muximodBaseUrl = normalizeMuximodBaseUrl(candidate.muximodBaseUrl);
  if (muximodBaseUrl !== candidate.muximodBaseUrl) {
    throw new BrowserConnectionProfileError("legacy connection profile has a non-canonical muximod URL");
  }
  validateProfileName(candidate.name);
  if (
    candidate.serverId !== undefined &&
    (typeof candidate.serverId !== "string" ||
      candidate.serverId.length === 0 ||
      candidate.serverId !== candidate.serverId.trim())
  ) {
    throw new BrowserConnectionProfileError("legacy connection profile has an invalid serverId");
  }
  return {
    id: "default",
    name: candidate.name,
    muximodBaseUrl,
    ...(typeof candidate.serverId === "string" ? { serverId: candidate.serverId } : {}),
    updatedAt: candidate.updatedAt,
  };
}

function normalizeProfileName(name: string, muximodBaseUrl: string, allowDefault = true): string {
  const normalized = name.trim();
  if (!normalized && allowDefault) return defaultConnectionProfileName(muximodBaseUrl);
  validateProfileName(normalized);
  return normalized;
}

function validateProfileName(name: string): void {
  if (name.length === 0 || name.length > 120 || !/^[^\u0000\r\n]+$/.test(name)) {
    throw new BrowserConnectionProfileError("connection profile name must be 1 to 120 characters without line breaks");
  }
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function getStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
