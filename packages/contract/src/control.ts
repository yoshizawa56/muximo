/** Host-only Unix-socket control contract. */

export type {
  ControlFrameDecode,
  MuximodControlRequest,
  MuximodControlResponse,
} from "./protocol.js";
export {
  decodeMuximodControlRequest,
  decodeMuximodControlResponse,
  encodeMuximodControlRequest,
  encodeMuximodControlResponse,
  muximodControlRequestSchema,
  muximodControlResponseSchema,
} from "./protocol.js";
