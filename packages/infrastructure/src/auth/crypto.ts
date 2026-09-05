// Node crypto is the infrastructure implementation of the application crypto port.
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import type { AuthCrypto } from "@muximo/application";
import { canonicalPublicJwk, pairingClaimMessage, sessionMessage } from "@muximo/domain";

export const nodeAuthCrypto: AuthCrypto = {
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
};

function decodeBase64Url(value: string): Uint8Array {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
