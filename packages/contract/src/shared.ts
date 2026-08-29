/** Minimal values shared by the QR pairing handoff and authentication code. */
export {
  canonicalPublicJwk,
  decodeBase64Url,
  decodePairingCode,
  encodeBase64Url,
  encodeJsonBase64Url,
  encodePairingCode,
  pairingClaimMessage,
  sessionMessage,
} from "./auth-crypto.js";
export type {
  AuthDeviceType,
  PairingCodePayload,
  PairingQrPayload,
  PublicKeyJwk,
} from "./protocol.js";
export {
  authDeviceTypeSchema,
  pairingCodePayloadSchema,
  pairingQrPayloadSchema,
  protocolVersion,
  publicKeyJwkSchema,
} from "./protocol.js";
