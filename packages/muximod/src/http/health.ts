import { type MuximodHealth, muximodHealthSchema } from "@muximo/contract/api";
import { protocolVersion } from "@muximo/contract/shared";
import { Schema } from "effect";

export type MuximodHealthUnavailable = {
  error: "muximod_unavailable";
  message: "muximod is still starting";
};

export type MuximodHealthPresentation =
  | { ready: true; status: 200; body: MuximodHealth }
  | { ready: false; status: 503; body: MuximodHealthUnavailable };

/** Builds the single health representation shared by raw HTTP and oRPC. */
export function presentMuximodHealth(configurationFingerprint: string, isReady = true): MuximodHealthPresentation {
  if (!isReady) {
    return {
      ready: false,
      status: 503,
      body: { error: "muximod_unavailable", message: "muximod is still starting" },
    };
  }
  return {
    ready: true,
    status: 200,
    body: Schema.decodeUnknownSync(muximodHealthSchema)({
      ok: true,
      service: "muximod",
      protocolVersion,
      pid: process.pid,
      configurationFingerprint,
    }),
  };
}
