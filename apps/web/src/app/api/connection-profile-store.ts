import { createBrowserMuximodAuth } from "./browser-auth";
import { createServeConnection, type MuximodConnection } from "./muximod-client.js";

export type BrowserConnectionProfile = {
  id: string;
  name: string;
  muximodBaseUrl: string;
  serverId?: string;
  updatedAt: string;
};

export class BrowserConnectionProfileError extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BrowserConnectionProfileError";
    if (cause !== undefined) Object.defineProperty(this, "cause", { configurable: true, value: cause });
  }
}

const storageKey = "muximo.connection-profile.v1";

export function readBrowserConnectionProfile(
  storage: Storage | undefined = getStorage(),
): BrowserConnectionProfile | null {
  if (!storage) return null;
  const raw = storage.getItem(storageKey);
  if (!raw) return null;
  try {
    return parseProfile(JSON.parse(raw));
  } catch {
    storage.removeItem(storageKey);
    return null;
  }
}

export function saveBrowserConnectionProfile(
  input: Pick<BrowserConnectionProfile, "name" | "muximodBaseUrl"> &
    Pick<Partial<BrowserConnectionProfile>, "serverId">,
  storage: Storage | undefined = getStorage(),
): BrowserConnectionProfile {
  const profile: BrowserConnectionProfile = {
    id: "default",
    name: input.name.trim() || new URL(input.muximodBaseUrl).hostname,
    muximodBaseUrl: normalizeMuximodBaseUrl(input.muximodBaseUrl),
    ...(input.serverId ? { serverId: input.serverId } : {}),
    updatedAt: new Date().toISOString(),
  };
  parseProfile(profile);
  storage?.setItem(storageKey, JSON.stringify(profile));
  return profile;
}

export function clearBrowserConnectionProfile(storage: Storage | undefined = getStorage()): void {
  storage?.removeItem(storageKey);
}

export function connectionForProfile(profile: BrowserConnectionProfile | null): MuximodConnection | undefined {
  if (!profile) return undefined;
  const connection = createServeConnection(profile.muximodBaseUrl);
  connection.auth = createBrowserMuximodAuth(connection);
  return connection;
}

export function normalizeMuximodBaseUrl(value: string): string {
  const url = new URL(value.trim());
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("muximod URL must use https:// (http:// is allowed only for local development)");
  }
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
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
    candidate.id !== "default" ||
    typeof candidate.name !== "string" ||
    candidate.name.length === 0 ||
    candidate.name !== candidate.name.trim() ||
    typeof candidate.muximodBaseUrl !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    !isIsoTimestamp(candidate.updatedAt) ||
    (candidate.serverId !== undefined &&
      (typeof candidate.serverId !== "string" ||
        candidate.serverId.length === 0 ||
        candidate.serverId !== candidate.serverId.trim()))
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
  return {
    id: "default",
    name: candidate.name,
    muximodBaseUrl,
    ...(typeof candidate.serverId === "string" ? { serverId: candidate.serverId } : {}),
    updatedAt: candidate.updatedAt,
  };
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
