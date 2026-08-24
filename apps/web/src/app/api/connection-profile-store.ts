import { createBrowserMuximodAuth } from "./browser-auth";
import { createServeConnection, type MuximodConnection } from "./muximod-client.js";

export type BrowserConnectionProfile = {
  id: string;
  name: string;
  muximodBaseUrl: string;
  serverId?: string;
  updatedAt: string;
};

const storageKey = "muximo.connection-profile.v1";

export function readBrowserConnectionProfile(
  storage: Storage | undefined = getStorage(),
): BrowserConnectionProfile | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return parseProfile(value);
  } catch {
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
  if (!value || typeof value !== "object") throw new Error("Invalid connection profile");
  const candidate = value as Record<string, unknown>;
  const muximodBaseUrl =
    typeof candidate.muximodBaseUrl === "string"
      ? candidate.muximodBaseUrl
      : typeof candidate.serveUrl === "string"
        ? candidate.serveUrl
        : undefined;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.name !== "string" ||
    !muximodBaseUrl ||
    typeof candidate.updatedAt !== "string"
  ) {
    throw new Error("Invalid connection profile");
  }
  return {
    id: candidate.id,
    name: candidate.name,
    muximodBaseUrl: normalizeMuximodBaseUrl(muximodBaseUrl),
    ...(typeof candidate.serverId === "string" ? { serverId: candidate.serverId } : {}),
    updatedAt: candidate.updatedAt,
  };
}

function getStorage(): Storage | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
