import { describe, it } from "vitest";
import {
  hasError,
  noFixture,
  returns,
  runOperationTable,
  type Assertion,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import type { PairingCodePayload, PairingQrPayload } from "./protocol.js";
import { decodePairingCode, encodeJsonBase64Url, encodePairingCode } from "./auth-crypto.js";

type EmptyContext = {};
type PairingCodeInput =
  | { type: "encode"; payload: PairingQrPayload }
  | { type: "decode"; value: string };
type PairingCodeResult = string | PairingCodePayload;

const payload: PairingQrPayload = {
  v: 2,
  muximodBaseUrl: "https://muximo-host.tailnet.ts.net:8444/",
  serverId: "server-1234567890123456",
  pairingId: "pairing-1234567890123456",
  pairingSecret: "abcdefghijklmnopqrstuvwxyz0123456789_-",
  expiresAt: 1_797_444_800_000,
};
const codePayload: PairingCodePayload = {
  muximodBaseUrl: "https://muximo-host.tailnet.ts.net:8444",
  pairingId: payload.pairingId,
  pairingSecret: payload.pairingSecret,
};

const hasRawPairingCodeShape = (): Assertion<EmptyContext, PairingCodeResult> => ({
  name: "returns an in-app pairing code",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    if (typeof result.value !== "string") throw new Error("expected an encoded pairing code");
    if (!/^ma3:[A-Za-z0-9_-]+$/.test(result.value)) throw new Error("pairing code is not a compact raw ma3 payload");
    if (result.value.length >= `ma2:${encodeJsonBase64Url(payload)}`.length) throw new Error("pairing code was not shortened");
    if (result.value.includes("/settings") || result.value.includes("http")) throw new Error("pairing code contains a web navigation target");
  },
});

const pairingCodeCases = [
  {
    name: "encodes a pairing payload as a raw in-app code",
    input: { type: "encode", payload },
    assert: [hasRawPairingCodeShape()],
  },
  {
    name: "round-trips the muximod endpoint and pairing secret",
    input: { type: "decode", value: encodePairingCode(payload) },
    assert: [returns<EmptyContext, PairingCodeResult>(codePayload)],
  },
  {
    name: "reads the previous JSON pairing code format",
    input: { type: "decode", value: `ma2:${encodeJsonBase64Url(payload)}` },
    assert: [returns<EmptyContext, PairingCodeResult>(codePayload)],
  },
  {
    name: "rejects a browser navigation URL",
    input: { type: "decode", value: "https://muximo-host.example/settings#ma1=payload" },
    assert: [hasError<EmptyContext, PairingCodeResult>({ message: "QR code is not a muximo pairing code" })],
  },
] satisfies readonly OperationCase<"default", PairingCodeInput, PairingCodeResult, EmptyContext>[];

const pairingCodeTable: OperationTable<undefined, "default", PairingCodeInput, PairingCodeResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: pairingCodeCases,
  execute: (_fixture, input) => input.type === "encode" ? encodePairingCode(input.payload) : decodePairingCode(input.value),
  observe: () => ({}),
};

describe("pairing code encoding", () => {
  runOperationTable(it as unknown as TestRegistrar, pairingCodeTable);
});
