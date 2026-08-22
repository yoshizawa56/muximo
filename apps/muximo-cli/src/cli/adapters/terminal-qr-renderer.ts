/// <reference path="./qrcode.d.ts" />

import QRCode from "qrcode";

export interface QrRendererPort {
  render(value: string): Promise<string>;
}

export type TerminalQrRendererOptions = {
  small?: boolean;
};

/** Terminal presentation adapter for the pairing URL supplied by muximod. */
export class TerminalQrRenderer implements QrRendererPort {
  public constructor(private readonly options: TerminalQrRendererOptions = {}) {}

  public render(value: string): Promise<string> {
    return QRCode.toString(value, {
      type: "terminal",
      errorCorrectionLevel: "Q",
      margin: 4,
      small: this.options.small ?? true,
    });
  }
}
