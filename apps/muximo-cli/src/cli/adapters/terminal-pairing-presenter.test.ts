import { Writable } from "node:stream";
import { describe, it } from "vitest";
import {
  hasObserved,
  runOperationTable,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import type { PairingOffer } from "@muximo/application";
import { TerminalPairingPresenter } from "./terminal-pairing-presenter.js";

class CaptureOutput extends Writable {
  public value = "";
  public _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error) => void): void { this.value += chunk.toString(); callback(); }
}

const offer: PairingOffer = {
  pairingId: "pairing-1234567890123456",
  pairingCode: "ma3:pairing-code",
  muximodBaseUrl: "https://muximod.example",
  expiresAt: Date.now() + 300_000,
};

type PresenterFixture = { out: CaptureOutput; received: string | undefined };
type PresenterContext = { received: string | undefined; output: boolean; instruction: boolean };
const presenterFixture = (): FixtureHandle<PresenterFixture> => ({ fixture: { out: new CaptureOutput(), received: undefined } });

const cases = [
  {
    name: "hands the structured pairing code to the terminal QR adapter",
    input: offer,
    assert: [
      hasObserved<PresenterContext, undefined>("received", offer.pairingCode),
      hasObserved<PresenterContext, undefined>("output", true),
      hasObserved<PresenterContext, undefined>("instruction", true),
    ],
  },
] satisfies readonly OperationCase<"default", PairingOffer, undefined, PresenterContext>[];

const table: OperationTable<PresenterFixture, "default", PairingOffer, undefined, PresenterContext> = {
  defaultFixture: presenterFixture,
  cases,
  execute: async (fixture, input) => {
    const presenter = new TerminalPairingPresenter({
      out: fixture.out,
      input: process.stdin,
      qrRenderer: {
        render: async (value) => { fixture.received = value; return "rendered-qr"; },
      },
    });
    await presenter.showPairing(input);
  },
  observe: (fixture) => ({ received: fixture.received, output: fixture.out.value.includes("rendered-qr"), instruction: fixture.out.value.includes("Scan this QR code in the Muximo app") }),
};

describe("TerminalPairingPresenter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
