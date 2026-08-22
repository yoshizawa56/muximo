import { describe, it } from "vitest";
import {
  hasError,
  noFixture,
  returns,
  runOperationTable,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { encodePairingCode } from "@muximo/contract";
import { parsePairingQrPayload } from "./browser-auth";
import type { PairingCodePayload } from "@muximo/contract";

type EmptyContext = {};
type PairingPayloadInput = { code: string };

const payload: PairingCodePayload = {
  muximodBaseUrl: "https://muximo-host.tailnet.ts.net:8444/",
  pairingId: "pairing-1234567890123456",
  pairingSecret: "abcdefghijklmnopqrstuvwxyz0123456789_-",
};
const normalizedPayload: PairingCodePayload = { ...payload, muximodBaseUrl: "https://muximo-host.tailnet.ts.net:8444" };

const cases = [
  {
    name: "parses the raw pairing code without a browser origin",
    input: { code: encodePairingCode(payload) },
    assert: [returns<EmptyContext, PairingCodePayload>(normalizedPayload)],
  },
  {
    name: "rejects a navigation URL instead of decoding it",
    input: { code: "https://muximo-host.example/settings#ma1=payload" },
    assert: [hasError<EmptyContext, PairingCodePayload>({ message: "QR code does not contain a valid muximo pairing code" })],
  },
  {
    name: "rejects an endpoint with an unsupported protocol",
    input: { code: encodePairingCode({ ...payload, muximodBaseUrl: "ftp://muximo-host.example" }) },
    assert: [hasError<EmptyContext, PairingCodePayload>({ message: "Pairing endpoint must use http or https" })],
  },
] satisfies readonly OperationCase<"default", PairingPayloadInput, PairingCodePayload, EmptyContext>[];

const table: OperationTable<undefined, "default", PairingPayloadInput, PairingCodePayload, EmptyContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => parsePairingQrPayload(input.code),
  observe: () => ({}),
};

describe("browser pairing code parsing", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
