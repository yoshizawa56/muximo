/** Host-only Unix-socket control contract. */

export type {
  ControlFrameDecode,
  MuximodConfigurationStatus,
  MuximodControlRequest,
  MuximodControlResponse,
  MuximodDaemonStatus,
  MuximodHostSettings,
  MuximodWebSettings,
} from "./protocol.js";
export {
  decodeMuximodControlRequest,
  decodeMuximodControlResponse,
  encodeMuximodControlRequest,
  encodeMuximodControlResponse,
  muximodControlMaxBufferedResponseBytes,
  muximodControlMaxPendingRequests,
  muximodControlMaxRequestBytes,
  muximodControlMaxResponseBytes,
  muximodControlRequestSchema,
  muximodControlResponseSchema,
  muximodWebProxySettingsSchema,
  muximodWebSettingsSchema,
} from "./protocol.js";
