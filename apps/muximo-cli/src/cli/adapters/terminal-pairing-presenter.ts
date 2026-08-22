import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { PairingClaim, PairingOffer, PairingPresenterPort } from "@muximo/application";
import { TerminalQrRenderer, type QrRendererPort } from "./terminal-qr-renderer.js";

export type TerminalPairingPresenterOptions = {
  out: Writable;
  input: Readable;
  qrRenderer?: QrRendererPort;
};

/** Terminal UI adapter for the pairing use case. */
export class TerminalPairingPresenter implements PairingPresenterPort {
  private readonly qrRenderer: QrRendererPort;

  public constructor(private readonly options: TerminalPairingPresenterOptions) {
    this.qrRenderer = options.qrRenderer ?? new TerminalQrRenderer({ small: false });
  }

  public async showPairing(offer: PairingOffer): Promise<void> {
    const qr = await this.qrRenderer.render(offer.pairingCode);
    this.write("muximo pair\n");
    this.write(`muximod: ${offer.muximodBaseUrl}\nExpires: ${new Date(offer.expiresAt).toLocaleString()}\n\n`);
    this.write(qr);
    if (!qr.endsWith("\n")) this.write("\n");
    this.write("Scan this QR code in the Muximo app. Waiting for a connection request.\n");
  }

  public async confirmPairing(claim: PairingClaim): Promise<boolean> {
    this.write(`\nConnection request received.\n  name: ${claim.deviceName}\n  type: ${claim.deviceType}\n  platform: ${claim.platform ?? "(not provided)"}\n  clientVersion: ${claim.clientVersion ?? "(not provided)"}\n  public key fingerprint: ${claim.keyFingerprint}\n`);
    const prompt = createInterface({ input: this.options.input, output: this.options.out });
    try {
      const answer = await prompt.question("Approve this device? [y/N] ");
      return /^(y|yes)$/i.test(answer.trim());
    } finally {
      prompt.close();
    }
  }

  private write(value: string): void {
    this.options.out.write(value);
  }
}
