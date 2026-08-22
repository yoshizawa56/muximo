import { pairingCodePayloadSchema, pairingQrPayloadSchema, type PairingCodePayload, type PairingQrPayload, type PublicKeyJwk } from "./protocol.js";
import { canonicalPublicJwk, pairingClaimMessage, sessionMessage } from "@muximo/domain";

export { canonicalPublicJwk, pairingClaimMessage, sessionMessage } from "@muximo/domain";

const pairingCodePrefix = "ma3:";
const legacyPairingCodePrefix = "ma2:";
const pairingCodeLengthBytes = 2;
const maxPairingCodeFieldBytes = 0xffff;

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function publicKeyFingerprint(jwk: PublicKeyJwk): Promise<string> {
  return sha256Base64Url(canonicalPublicJwk(jwk));
}

export async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return encodeBase64Url(new Uint8Array(digest));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function signEcdsa(privateKey: CryptoKey, message: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(message),
  );
  return encodeBase64Url(new Uint8Array(signature));
}

export function encodeJsonBase64Url(value: unknown): string {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export function decodeJsonBase64Url<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

export function encodePairingCode(payload: PairingQrPayload | PairingCodePayload): string {
  const fields = [
    normalizePairingEndpoint(payload.muximodBaseUrl),
    payload.pairingId,
    payload.pairingSecret,
  ].map((value) => new TextEncoder().encode(value));
  const byteLength = fields.reduce((total, field) => total + field.length, (fields.length - 1) * pairingCodeLengthBytes);
  if (byteLength > 0xffff_ffff) throw new Error("pairing code is too large");
  const bytes = new Uint8Array(byteLength);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const field of fields.slice(0, -1)) {
    if (field.length > maxPairingCodeFieldBytes) throw new Error("pairing code field is too large");
    view.setUint16(offset, field.length);
    offset += pairingCodeLengthBytes;
    bytes.set(field, offset);
    offset += field.length;
  }
  bytes.set(fields[2]!, offset);
  return `${pairingCodePrefix}${encodeBase64Url(bytes)}`;
}

export function decodePairingCode(value: string): PairingCodePayload {
  const trimmed = value.trim();
  if (trimmed.startsWith(legacyPairingCodePrefix)) {
    const legacy = pairingQrPayloadSchema.parse(decodeJsonBase64Url<PairingQrPayload>(trimmed.slice(legacyPairingCodePrefix.length)));
    return pairingCodePayloadSchema.parse({
      muximodBaseUrl: normalizePairingEndpoint(legacy.muximodBaseUrl),
      pairingId: legacy.pairingId,
      pairingSecret: legacy.pairingSecret,
    });
  }
  if (!trimmed.startsWith(pairingCodePrefix)) throw new Error("QR code is not a muximo pairing code");
  const bytes = decodeBase64Url(trimmed.slice(pairingCodePrefix.length));
  let offset = 0;
  const fields: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    if (offset + pairingCodeLengthBytes > bytes.length) throw new Error("pairing code is truncated");
    const length = new DataView(bytes.buffer, bytes.byteOffset + offset, pairingCodeLengthBytes).getUint16(0);
    offset += pairingCodeLengthBytes;
    const end = offset + length;
    if (end > bytes.length) throw new Error("pairing code is truncated");
    fields.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, end)));
    offset = end;
  }
  if (offset >= bytes.length) throw new Error("pairing code is missing its secret");
  fields.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset)));
  return pairingCodePayloadSchema.parse({ muximodBaseUrl: fields[0], pairingId: fields[1], pairingSecret: fields[2] });
}

function normalizePairingEndpoint(value: string): string {
  return value.replace(/\/+$/, "");
}
