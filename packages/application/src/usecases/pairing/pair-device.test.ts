import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { PairDeviceResult, PairingClaim, PairingOffer } from "../../models/pairing.js";
import type { PairingControlPort, PairingPresenterPort } from "../../ports/pairing.js";
import { PairDevice } from "./pair-device.js";

const offer: PairingOffer = {
  pairingId: "pairing-1234567890123456",
  pairingCode: "ma3:pairing-code",
  muximodBaseUrl: "https://muximod.example",
  expiresAt: Date.now() + 300_000,
};

const claim: PairingClaim = {
  pairingId: offer.pairingId,
  serverId: "server-1234567890123456",
  deviceName: "Test browser",
  deviceType: "browser",
  platform: "test",
  clientVersion: "test",
  keyFingerprint: "fingerprint",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

class FakeControl implements PairingControlPort {
  public readonly calls: string[] = [];
  public async createPairing(): Promise<PairingOffer> {
    this.calls.push("create");
    return offer;
  }
  public async waitForClaim(pairingId: string): Promise<PairingClaim> {
    this.calls.push(`wait:${pairingId}`);
    return claim;
  }
  public async approvePairing(pairingId: string) {
    this.calls.push(`approve:${pairingId}`);
    return { deviceId: "device-1" };
  }
  public async rejectPairing(pairingId: string): Promise<void> {
    this.calls.push(`reject:${pairingId}`);
  }
}

class FakePresenter implements PairingPresenterPort {
  public readonly calls: string[] = [];
  public constructor(private readonly answer: boolean) {}
  public async showPairing(received: PairingOffer): Promise<void> {
    this.calls.push(`show:${received.pairingId}`);
  }
  public async confirmPairing(received: PairingClaim): Promise<boolean> {
    this.calls.push(`confirm:${received.pairingId}`);
    return this.answer;
  }
}

type PairFixture = { control: FakeControl; presenter: FakePresenter };
type PairInput = { muximodBaseUrl: string };
type PairContext = { controlCalls: readonly string[]; presenterCalls: readonly string[] };
type PairKey = "approved" | "rejected";

const createPairFixture =
  (answer: boolean): (() => FixtureHandle<PairFixture>) =>
  () => ({
    fixture: { control: new FakeControl(), presenter: new FakePresenter(answer) },
  });

const pairCases = [
  {
    name: "coordinates offer, claim, approval, and result",
    fixture: "approved",
    input: { muximodBaseUrl: offer.muximodBaseUrl },
    assert: [
      returns<PairContext, PairDeviceResult>({ status: "approved", deviceId: "device-1" }),
      hasObserved<PairContext, PairDeviceResult>("controlCalls", [
        "create",
        `wait:${offer.pairingId}`,
        `approve:${offer.pairingId}`,
      ]),
      hasObserved<PairContext, PairDeviceResult>("presenterCalls", [
        `show:${offer.pairingId}`,
        `confirm:${offer.pairingId}`,
      ]),
    ],
  },
  {
    name: "rejects after a negative presentation decision",
    fixture: "rejected",
    input: { muximodBaseUrl: offer.muximodBaseUrl },
    assert: [
      returns<PairContext, PairDeviceResult>({ status: "rejected" }),
      hasObserved<PairContext, PairDeviceResult>("controlCalls", [
        "create",
        `wait:${offer.pairingId}`,
        `reject:${offer.pairingId}`,
      ]),
    ],
  },
] satisfies readonly OperationCase<PairKey, PairInput, PairDeviceResult, PairContext>[];

const pairTable: OperationTable<PairFixture, PairKey, PairInput, PairDeviceResult, PairContext> = {
  defaultFixture: createPairFixture(true),
  fixtures: {
    approved: createPairFixture(true),
    rejected: createPairFixture(false),
  },
  cases: pairCases,
  execute: (fixture, input) => new PairDevice(fixture.control, fixture.presenter).execute(input),
  observe: (fixture) => ({ controlCalls: [...fixture.control.calls], presenterCalls: [...fixture.presenter.calls] }),
};

describe("PairDevice use case", () => {
  runOperationTable(it as unknown as TestRegistrar, pairTable);
});
