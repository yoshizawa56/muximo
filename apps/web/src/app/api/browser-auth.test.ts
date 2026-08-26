import type { PairingCodePayload } from "@muximo/contract";
import { encodePairingCode } from "@muximo/contract";
import {
  type Assertion,
  type FixtureHandle,
  hasError,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { type BrowserPairingPreview, inspectPairingQr, parsePairingQrPayload } from "./browser-auth";

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
    assert: [
      hasError<EmptyContext, PairingCodePayload>({ message: "QR code does not contain a valid muximo pairing code" }),
    ],
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

type InspectRequest = { method: string; url: string; body: string };
type InspectFixture = { originalFetch: typeof globalThis.fetch; requests: InspectRequest[] };
type InspectContext = { requests: readonly InspectRequest[] };
type InspectInput = { code: string };

const inspectFixture = (): FixtureHandle<InspectFixture> => {
  const originalFetch = globalThis.fetch;
  const requests: InspectRequest[] = [];
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({ method: request.method, url: request.url, body: await request.clone().text() });
    return new Response(
      JSON.stringify({
        json: {
          protocolVersion: 1,
          serverId: "server-preview-123456",
          serverTime: "2026-08-15T00:00:00.000Z",
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return {
    fixture: { originalFetch, requests },
    cleanup: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const hasPublicInfoRequest = (): Assertion<InspectContext, BrowserPairingPreview> => ({
  name: "requests only the public auth.info endpoint",
  check: (context) => {
    expect(context.requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "POST", url: "https://muximo-host.tailnet.ts.net:8444/rpc/auth/info" },
    ]);
  },
});

const hasNoPairingSecret = (): Assertion<InspectContext, BrowserPairingPreview> => ({
  name: "does not send the pairing secret during preview",
  check: (context) => {
    expect(context.requests.every(({ body }) => !body.includes(payload.pairingSecret))).toBe(true);
  },
});

const inspectCases = [
  {
    name: "reads the endpoint and server identity before a claim is sent",
    input: { code: encodePairingCode(payload) },
    assert: [
      returns<InspectContext, BrowserPairingPreview>({
        muximodBaseUrl: normalizedPayload.muximodBaseUrl,
        serverId: "server-preview-123456",
      }),
      hasPublicInfoRequest(),
      hasNoPairingSecret(),
    ],
  },
] satisfies readonly OperationCase<"default", InspectInput, BrowserPairingPreview, InspectContext>[];

const inspectTable: OperationTable<InspectFixture, "default", InspectInput, BrowserPairingPreview, InspectContext> = {
  defaultFixture: inspectFixture,
  cases: inspectCases,
  execute: (_fixture, input) => inspectPairingQr(input.code),
  observe: (fixture) => ({ requests: [...fixture.requests] }),
};

describe("browser pairing preview", () => {
  runOperationTable(it as unknown as TestRegistrar, inspectTable);
});
