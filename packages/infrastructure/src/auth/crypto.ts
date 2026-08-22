// Node crypto is the infrastructure implementation of the application crypto port.
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import { canonicalPublicJwk, pairingClaimMessage, sessionMessage } from "@muximo/domain";
import { AuthStoreError, type AuthCryptoPort, type PublicKeyJwk } from "@muximo/application";

export const nodeAuthCrypto: AuthCryptoPort = {
  randomOpaque(bytes) {
    return randomBytes(bytes).toString("base64url");
  },
  hashOpaque(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
  },
  fingerprint(publicKey) {
    return createHash("sha256").update(canonicalPublicJwk(publicKey), "utf8").digest("base64url");
  },
  pairingClaimMessage,
  sessionMessage,
  verifyPublicKeySignature(publicKey, message, signature) {
    try {
      return verifySignature(
        "sha256",
        Buffer.from(message, "utf8"),
        { key: createPublicKey({ key: publicKey, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        Buffer.from(decodeBase64Url(signature)),
      );
    } catch {
      return false;
    }
  },
  parsePublicKey(value): PublicKeyJwk {
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
    if (record.kty !== "EC" || record.crv !== "P-256" || typeof record.x !== "string" || typeof record.y !== "string") {
      throw new AuthStoreError("device_key_invalid", "stored device public key is invalid");
    }
    return { kty: "EC", crv: "P-256", x: record.x, y: record.y };
  },
};

function decodeBase64Url(value: string): Uint8Array {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
