import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PairingClaim, PairingOffer, PairingPresenterPort } from "@muximo/application";
import { SvgQrRenderer } from "./svg-qr-renderer.js";
import type { QrRendererPort } from "./terminal-qr-renderer.js";

export type BrowserLaunchSpec = {
  command: string;
  args: readonly string[];
};

export type BrowserPairingPresenterOptions = {
  out: Writable;
  input: Readable;
  qrRenderer?: QrRendererPort;
  browserLauncher?: (filePath: string) => Promise<void>;
};

type PairingPage = {
  directory: string;
  filePath: string;
};

/** Pairing presenter that displays the QR in a local browser page. */
export class BrowserPairingPresenter implements PairingPresenterPort {
  private readonly qrRenderer: QrRendererPort;
  private page: PairingPage | undefined;
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(private readonly options: BrowserPairingPresenterOptions) {
    this.qrRenderer = options.qrRenderer ?? new SvgQrRenderer();
  }

  public async showPairing(offer: PairingOffer): Promise<void> {
    await this.close();
    const qr = await this.qrRenderer.render(offer.pairingCode);
    const directory = await mkdtemp(join(tmpdir(), "muximo-pair-"));
    const filePath = join(directory, "index.html");

    try {
      await writeFile(filePath, renderPairingPage(qr, offer), { encoding: "utf8", mode: 0o600 });
      const browserLauncher = this.options.browserLauncher ?? openInBrowser;
      await browserLauncher(filePath);
      this.page = { directory, filePath };
      this.scheduleExpiry(offer.expiresAt);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }

    this.write("muximo pair\n");
    this.write(`muximod: ${offer.muximodBaseUrl}\nExpires: ${new Date(offer.expiresAt).toLocaleString()}\n`);
    this.write(`Opened pairing QR in the default browser: ${filePath}\n`);
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
      await this.close();
    }
  }

  public async close(): Promise<void> {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }
    const page = this.page;
    this.page = undefined;
    if (page) await rm(page.directory, { recursive: true, force: true });
  }

  private scheduleExpiry(expiresAt: number): void {
    const delay = Math.max(0, expiresAt - Date.now() + 1_000);
    this.expiryTimer = setTimeout(() => {
      void this.close();
    }, delay);
    this.expiryTimer.unref?.();
  }

  private write(value: string): void {
    this.options.out.write(value);
  }
}

export function browserLaunchSpec(filePath: string, platform: NodeJS.Platform = process.platform): BrowserLaunchSpec {
  if (platform === "darwin") return { command: "open", args: [filePath] };
  if (platform === "win32") {
    const quotedPath = filePath.replaceAll('"', '""');
    return { command: "cmd.exe", args: ["/d", "/s", "/c", `start "" "${quotedPath}"`] };
  }
  return { command: "xdg-open", args: [filePath] };
}

async function openInBrowser(filePath: string): Promise<void> {
  const spec = browserLaunchSpec(filePath);
  const child = Bun.spawn([spec.command, ...spec.args], { stdout: "ignore", stderr: "ignore" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`could not open pairing QR with ${spec.command}`);
}

function renderPairingPage(svg: string, offer: PairingOffer): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Muximo pairing</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f4f5; color: #18181b; font: 16px -apple-system, BlinkMacSystemFont, sans-serif; }
      main { padding: 32px; text-align: center; background: white; border-radius: 16px; box-shadow: 0 8px 30px #0002; }
      svg { display: block; width: min(80vw, 420px); height: auto; margin: 20px auto; }
      p { margin: 8px 0; color: #52525b; }
    </style>
  </head>
  <body>
    <main>
      <h1>Muximo pairing</h1>
      ${svg}
      <p>Scan this QR code in the Muximo app.</p>
      <p>Endpoint: ${escapeHtml(offer.muximodBaseUrl)}</p>
      <p>Expires: ${escapeHtml(new Date(offer.expiresAt).toLocaleString())}</p>
    </main>
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}
