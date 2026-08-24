/// <reference path="./qrcode.d.ts" />

import QRCode from "qrcode";
import type { QrRendererPort } from "./terminal-qr-renderer.js";

/** SVG presentation adapter for QR codes displayed in a browser. */
export class SvgQrRenderer implements QrRendererPort {
  public render(value: string): Promise<string> {
    return QRCode.toString(value, {
      type: "svg",
      errorCorrectionLevel: "Q",
      margin: 4,
    });
  }
}
