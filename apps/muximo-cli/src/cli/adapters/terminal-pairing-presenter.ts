import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { ApplicationEffect, PairingClaim, PairingOffer, PairingPresenter } from "@muximo/application";
import { fromPromise } from "@muximo/infrastructure/cli-client";
import { type QrRendererPort, TerminalQrRenderer } from "./terminal-qr-renderer.js";

export type TerminalPairingPresenterOptions = {
  out: Writable;
  input: Readable;
  qrRenderer?: QrRendererPort;
};

/** Terminal UI adapter for the pairing use case. */
export class TerminalPairingPresenter implements PairingPresenter {
  private readonly qrRenderer: QrRendererPort;

  public constructor(private readonly options: TerminalPairingPresenterOptions) {
    this.qrRenderer = options.qrRenderer ?? new TerminalQrRenderer({ small: false });
  }

  public showPairing(offer: PairingOffer): ApplicationEffect<void> {
    return fromPromise(async () => {
      const qr = await this.qrRenderer.render(offer.pairingCode);
      this.write("muximo pair\n");
      this.write(`muximod: ${offer.muximodBaseUrl}\nExpires: ${new Date(offer.expiresAt).toLocaleString()}\n\n`);
      this.write(qr);
      if (!qr.endsWith("\n")) this.write("\n");
      this.write("Scan this QR code in the Muximo app. Waiting for a connection request.\n");
    });
  }

  public confirmPairing(claim: PairingClaim): ApplicationEffect<boolean> {
    return fromPromise(async () => {
      this.write(
        `\nConnection request received.\n  name: ${claim.deviceName}\n  type: ${claim.deviceType}\n  platform: ${claim.platform ?? "(not provided)"}\n  clientVersion: ${claim.clientVersion ?? "(not provided)"}\n  public key fingerprint: ${claim.keyFingerprint}\n`,
      );
      const prompt = createInterface({ input: this.options.input, output: this.options.out });
      try {
        const answer = await prompt.question("Approve this device? [y/N] ");
        return /^(y|yes)$/i.test(answer.trim());
      } finally {
        prompt.close();
      }
    });
  }

  private write(value: string): void {
    this.options.out.write(value);
  }
}
