import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, it } from "vitest";
import type { PairingClaim, PairingOffer } from "@muximo/application";
import {
  hasObserved,
  noFixture,
  returns,
  runOperationTable,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { BrowserPairingPresenter, browserLaunchSpec, type BrowserLaunchSpec } from "./browser-pairing-presenter.js";

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

type PresenterFixture = {
  out: CaptureOutput;
  received: string | undefined;
  openedPath: string | undefined;
  openedContent: string | undefined;
};

type PresenterInput = {
  answer: "y" | "n";
};

type PresenterContext = {
  received: string | undefined;
  output: boolean;
  pageHasQr: boolean;
  temporaryPageRemoved: boolean;
};

const presenterFixture = (): FixtureHandle<PresenterFixture> => {
  const fixture: PresenterFixture = {
    out: new CaptureOutput(),
    received: undefined,
    openedPath: undefined,
    openedContent: undefined,
  };
  return {
    fixture,
    cleanup: async () => {
      if (fixture.openedPath) await rm(dirname(fixture.openedPath), { recursive: true, force: true });
    },
  };
};

const presenterCases = [
  {
    name: "opens the pairing QR in a browser and removes it after approval",
    input: { answer: "y" },
    assert: [
      returns<PresenterContext, boolean>(true),
      hasObserved<PresenterContext, boolean>("received", offer.pairingCode),
      hasObserved<PresenterContext, boolean>("output", true),
      hasObserved<PresenterContext, boolean>("pageHasQr", true),
      hasObserved<PresenterContext, boolean>("temporaryPageRemoved", true),
    ],
  },
  {
    name: "removes the pairing QR after rejection",
    input: { answer: "n" },
    assert: [
      returns<PresenterContext, boolean>(false),
      hasObserved<PresenterContext, boolean>("temporaryPageRemoved", true),
    ],
  },
] satisfies readonly OperationCase<"default", PresenterInput, boolean, PresenterContext>[];

const presenterTable: OperationTable<PresenterFixture, "default", PresenterInput, boolean, PresenterContext> = {
  defaultFixture: presenterFixture,
  cases: presenterCases,
  execute: async (fixture, input) => {
    const presenter = new BrowserPairingPresenter({
      out: fixture.out,
      input: Readable.from([`${input.answer}\n`]),
      qrRenderer: {
        render: async (value) => {
          fixture.received = value;
          return '<svg data-test="qr" />';
        },
      },
      browserLauncher: async (filePath) => {
        fixture.openedPath = filePath;
        fixture.openedContent = readFileSync(filePath, "utf8");
      },
    });
    await presenter.showPairing(offer);
    return presenter.confirmPairing(claim);
  },
  observe: (fixture) => ({
    received: fixture.received,
    output: fixture.out.value.includes("Opened pairing QR in the default browser") && fixture.out.value.includes("Approve this device?"),
    pageHasQr: fixture.openedContent?.includes('<svg data-test="qr" />') ?? false,
    temporaryPageRemoved: fixture.openedPath ? !existsSync(fixture.openedPath) : false,
  }),
};

type BrowserLaunchInput = {
  filePath: string;
  platform: NodeJS.Platform;
};

const browserLaunchCases = [
  {
    name: "uses open on macOS",
    input: { filePath: "/tmp/qr.html", platform: "darwin" },
    assert: [returns<BrowserLaunchSpec, BrowserLaunchSpec>({ command: "open", args: ["/tmp/qr.html"] })],
  },
  {
    name: "uses xdg-open on Linux",
    input: { filePath: "/tmp/qr.html", platform: "linux" },
    assert: [returns<BrowserLaunchSpec, BrowserLaunchSpec>({ command: "xdg-open", args: ["/tmp/qr.html"] })],
  },
  {
    name: "uses start through cmd on Windows",
    input: { filePath: "C:\\Temp\\qr page.html", platform: "win32" },
    assert: [returns<BrowserLaunchSpec, BrowserLaunchSpec>({ command: "cmd.exe", args: ["/d", "/s", "/c", 'start "" "C:\\Temp\\qr page.html"'] })],
  },
] satisfies readonly OperationCase<"default", BrowserLaunchInput, BrowserLaunchSpec, BrowserLaunchSpec>[];

const browserLaunchTable: OperationTable<undefined, "default", BrowserLaunchInput, BrowserLaunchSpec, BrowserLaunchSpec> = {
  defaultFixture: noFixture(),
  cases: browserLaunchCases,
  execute: (_fixture, input) => browserLaunchSpec(input.filePath, input.platform),
  observe: (_fixture, result) => result.ok ? result.value : { command: "", args: [] },
};

describe("browser pairing presenter", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, presenterTable);
  runOperationTable(register, browserLaunchTable);
});
