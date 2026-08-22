import {
  createServeConnection,
  muximodRpc,
  type MuximodAuthProvider,
  type MuximodConnection,
  type MuximodRpcClient,
} from "./muximod-client.js";
import {
  decodePairingCode,
  pairingCodePayloadSchema,
  type PairingCodePayload,
  type PairingClaimRequest,
  type PublicKeyJwk,
} from "@muximo/contract";
import {
  encodeJsonBase64Url,
  pairingClaimMessage,
  publicKeyFingerprint,
  sessionMessage,
  sha256Hex,
  signEcdsa,
} from "@muximo/contract";

type StoredBrowserDevice = {
  serverId: string;
  deviceId: string;
  publicKey: PublicKeyJwk;
  privateKey: CryptoKey;
};

type CachedSession = {
  serverId: string;
  deviceId: string;
  accessToken: string;
  expiresAt: string;
};

const authDatabaseName = "muximo.auth.v1";
const authStoreName = "devices";
const clientVersion = "web";

export type BrowserPairingProgress =
  | { phase: "claiming" }
  | { phase: "awaiting_approval"; fingerprint: string }
  | { phase: "approved" };

export type BrowserPairingResult = {
  payload: PairingCodePayload;
  serverId: string;
  deviceId: string;
  deviceName: string;
};

export function parsePairingQrPayload(value: string): PairingCodePayload {
  let payload: PairingCodePayload;
  try {
    payload = pairingCodePayloadSchema.parse(decodePairingCode(value));
  } catch {
    throw new Error("QR code does not contain a valid muximo pairing code");
  }
  if (new URL(payload.muximodBaseUrl).protocol !== "http:" && new URL(payload.muximodBaseUrl).protocol !== "https:") {
    throw new Error("Pairing endpoint must use http or https");
  }
  return payload;
}

export async function pairBrowserFromQr(
  value: string,
  options: {
    deviceName: string;
    onProgress?: (progress: BrowserPairingProgress) => void;
  },
): Promise<BrowserPairingResult> {
  const payload = parsePairingQrPayload(value);
  const connection = createServeConnection(payload.muximodBaseUrl);
  const client: MuximodRpcClient = muximodRpc(connection);
  const info = await client.auth.info({});
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const parsedPublicKey = publicKeyJwk(publicKey);
  const fingerprint = await publicKeyFingerprint(parsedPublicKey);
  const clientNonce = randomNonce();
  const pairingSecretHash = await sha256Hex(payload.pairingSecret);
  const claimMessage = pairingClaimMessage({
    serverId: info.serverId,
    pairingId: payload.pairingId,
    pairingSecretHash,
    keyFingerprint: fingerprint,
    clientNonce,
  });

  options.onProgress?.({ phase: "claiming" });
  const claimRequest: PairingClaimRequest = {
    pairingSecret: payload.pairingSecret,
    publicKey: parsedPublicKey,
    deviceName: options.deviceName.trim() || defaultDeviceName(),
    deviceType: "browser",
    platform: typeof navigator === "undefined" ? undefined : navigator.platform,
    clientVersion,
    clientNonce,
    signature: await signEcdsa(keyPair.privateKey, claimMessage),
  };
  const claim = await client.auth.claimPairing({ pairingId: payload.pairingId, request: claimRequest });
  if (claim.serverId !== info.serverId || claim.pairingId !== payload.pairingId) throw new Error("muximod returned an unexpected pairing identity");
  options.onProgress?.({ phase: "awaiting_approval", fingerprint: claim.keyFingerprint });

  const status = await waitForPairingApproval(client, payload.pairingId, claim.claimToken);
  if (status.status !== "approved" || !status.deviceId) throw new Error(`Pairing was ${status.status}`);
  await saveBrowserDevice({
    serverId: info.serverId,
    deviceId: status.deviceId,
    publicKey: parsedPublicKey,
    privateKey: keyPair.privateKey,
  });
  options.onProgress?.({ phase: "approved" });
  return { payload, serverId: info.serverId, deviceId: status.deviceId, deviceName: options.deviceName.trim() || defaultDeviceName() };
}

export function createBrowserMuximodAuth(connection: MuximodConnection): MuximodAuthProvider {
  let cached: CachedSession | undefined;
  const client = muximodRpc(connection);
  const publicClient = muximodRpc({ ...connection, auth: undefined });
  const provider: MuximodAuthProvider = {
    getAccessToken: async () => {
      const info = await publicClient.auth.info({});
      if (cached && cached.serverId === info.serverId && cached.expiresAt > new Date(Date.now() + 30_000).toISOString()) return cached.accessToken;

      const device = await loadBrowserDevice(info.serverId);
      if (!device) throw new Error("This browser is not paired with muximod");
      const challenge = await publicClient.auth.createChallenge({ deviceId: device.deviceId });
      const signature = await signEcdsa(device.privateKey, sessionMessage({
        serverId: info.serverId,
        deviceId: device.deviceId,
        challengeId: challenge.challengeId,
        challengeNonce: challenge.nonce,
        expiresAt: challenge.expiresAt,
      }));
      const session = await publicClient.auth.createSession({ deviceId: device.deviceId, challengeId: challenge.challengeId, signature });
      if (session.serverId !== info.serverId || session.deviceId !== device.deviceId) throw new Error("muximod returned an unexpected session identity");
      cached = { serverId: session.serverId, deviceId: session.deviceId, accessToken: session.accessToken, expiresAt: session.expiresAt };
      return session.accessToken;
    },
    getWebSocketTicket: async (endpoint) => {
      return (await client.auth.issueWebSocketTicket({ endpoint })).ticket;
    },
  };
  return provider;
}

async function waitForPairingApproval(client: MuximodRpcClient, pairingId: string, claimToken: string): Promise<{ status: "offered" | "awaiting_approval" | "approved" | "rejected" | "expired"; deviceId: string | null }> {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const status = await client.auth.pairingStatus({ pairingId, claimToken }, { context: { pairingToken: claimToken } });
    if (status.status === "approved" || status.status === "rejected" || status.status === "expired") return status;
    await wait(1_000);
  }
  throw new Error("Pairing approval timed out");
}

function publicKeyJwk(value: JsonWebKey): PublicKeyJwk {
  if (value.kty !== "EC" || value.crv !== "P-256" || !value.x || !value.y) throw new Error("browser could not export a P-256 public key");
  return { kty: "EC", crv: "P-256", x: value.x, y: value.y };
}

function randomNonce(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return encodeJsonBase64Url([...bytes]);
}

function defaultDeviceName(): string {
  return typeof navigator === "undefined" ? "Browser" : navigator.userAgent.slice(0, 80) || "Browser";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function openAuthDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") throw new Error("This browser does not support secure key storage");
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(authDatabaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(authStoreName, { keyPath: "serverId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("could not open browser key storage"));
  });
}

async function saveBrowserDevice(device: StoredBrowserDevice): Promise<void> {
  const database = await openAuthDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(authStoreName, "readwrite");
    transaction.objectStore(authStoreName).put(device);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("could not store browser key"));
  });
  database.close();
}

async function loadBrowserDevice(serverId: string): Promise<StoredBrowserDevice | null> {
  const database = await openAuthDatabase();
  return new Promise((resolve, reject) => {
    const request = database.transaction(authStoreName, "readonly").objectStore(authStoreName).get(serverId);
    request.onsuccess = () => {
      database.close();
      resolve((request.result as StoredBrowserDevice | undefined) ?? null);
    };
    request.onerror = () => {
      database.close();
      reject(request.error ?? new Error("could not read browser key"));
    };
  });
}
