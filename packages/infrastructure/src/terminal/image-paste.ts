// Image-paste integration is a terminal transport adapter, not application behavior.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImagePasteInput } from "./contracts.js";

export type { ImagePasteInput, ImagePaster } from "./contracts.js";

/**
 * Host-side delivery for images pasted from the mobile app.
 *
 * Pasting an image into a terminal emulator such as Terminal.app or iTerm2
 * sends an iTerm2 inline-image escape sequence (OSC 1337) to the foreground
 * application, which agent CLIs parse to attach the image. muximod reproduces
 * that behavior for a tmux pane:
 *
 * 1. The OSC 1337 sequence is stored in a tmux buffer and pasted into the
 *    pane. `tmux paste-buffer` writes raw bytes into the pane's PTY, so the
 *    sequence reaches the foreground application unparsed by tmux.
 * 2. On macOS the image is staged immediately before it is written to the
 *    system pasteboard, which makes it available to clipboard-reading agent
 *    CLIs and to the desktop user. The staged file is removed after the
 *    synchronous clipboard consumer finishes.
 *
 * The OSC/tmux path is independent of temporary-file staging, and non-macOS
 * platforms do not create a temporary file.
 */

export type ImagePasteResult = {
  bytes: number;
  name: string;
  clipboard: "set" | "unavailable" | "failed";
};

export type ImagePasteAdapter = {
  setBuffer(name: string, data: Buffer): void;
  pasteBuffer(name: string, targetPaneId: string): void;
  deleteBuffer(name: string): void;
};

export type CommandResult = { status: number | null };

export type ImagePasterOptions = {
  tmux: ImagePasteAdapter;
  platform?: NodeJS.Platform;
  tempDir?: string;
  runOsascript?: (script: string) => CommandResult;
  /** Injectable file staging for tests; production writes to the temp dir. */
  stageImage?: (input: ImagePasteInput, tempDir: string) => string;
  /** Injectable cleanup for tests; production removes the staged file. */
  cleanupImage?: (path: string) => void;
};

export function createImagePaster(options: ImagePasterOptions): (input: ImagePasteInput) => Promise<ImagePasteResult> {
  const platform = options.platform ?? process.platform;
  const runOsascript = options.runOsascript ?? runOsascriptCommand;
  const stageImage = options.stageImage ?? stageTempImage;
  const cleanupImage = options.cleanupImage ?? unlinkSync;

  return async (input) => {
    const bufferName = `muximod-paste-${randomBytes(6).toString("hex")}`;
    const sequence = inlineImageSequence(input.name, input.bytes);

    let bufferSet = false;
    try {
      options.tmux.setBuffer(bufferName, Buffer.from(sequence, "utf8"));
      bufferSet = true;
      options.tmux.pasteBuffer(bufferName, input.paneId);
    } finally {
      if (bufferSet) {
        try {
          options.tmux.deleteBuffer(bufferName);
        } catch {
          // The buffer is a best-effort staging area; the paste already ran.
        }
      }
    }

    return {
      bytes: input.bytes.length,
      name: input.name,
      clipboard:
        platform === "darwin"
          ? setDarwinClipboardImage(input, options.tempDir ?? tmpdir(), runOsascript, stageImage, cleanupImage)
          : "unavailable",
    };
  };
}

/** iTerm2 inline-image sequence as sent by macOS terminal emulators on paste. */
export function inlineImageSequence(name: string, bytes: Buffer): string {
  const safeName = sanitizeInlineImageName(name);
  return `\x1b]1337;file=inline=1;name=${safeName}:${bytes.toString("base64")}\x07`;
}

export function sanitizeInlineImageName(name: string): string {
  const sanitized = name
    .replaceAll(/[^\x20-\x7e]/g, "_")
    .replaceAll(/[:;]/g, "_")
    .trim();
  return (sanitized || "image").slice(0, 255);
}

function stageTempImage(input: ImagePasteInput, tempDir: string): string {
  const filePath = join(
    tempDir,
    `muximod-paste-${randomBytes(8).toString("hex")}${extensionForMimeType(input.mimeType)}`,
  );
  writeFileSync(filePath, input.bytes, { mode: 0o600 });
  return filePath;
}

function extensionForMimeType(mimeType: string | undefined): string {
  switch (mimeType?.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    case "image/heic":
      return ".heic";
    case "image/tiff":
      return ".tiff";
    case "image/bmp":
      return ".bmp";
    default:
      return ".img";
  }
}

function setDarwinClipboardImage(
  input: ImagePasteInput,
  tempDir: string,
  runOsascript: (script: string) => CommandResult,
  stageImage: (input: ImagePasteInput, tempDir: string) => string,
  cleanupImage: (path: string) => void,
): ImagePasteResult["clipboard"] {
  const path = stageImage(input, tempDir);
  try {
    const result = runOsascript(osascriptClipboardScript(path));
    return result.status === 0 ? "set" : "failed";
  } catch {
    return "failed";
  } finally {
    try {
      cleanupImage(path);
    } catch {
      // The synchronous clipboard consumer has finished. Cleanup is best
      // effort so a filesystem race cannot turn a successful paste into a retry.
    }
  }
}

function osascriptClipboardScript(path: string): string {
  const literal = JSON.stringify(path);
  return [
    "ObjC.import('AppKit');",
    `var data = $.NSData.alloc.initWithContentsOfFile(${literal});`,
    "if (data) {",
    "  var image = $.NSImage.alloc.initWithData(data);",
    "  if (image) {",
    "    $.NSPasteboard.generalPasteboard.clearContents;",
    "    $.NSPasteboard.generalPasteboard.writeObjects([image]);",
    "  }",
    "}",
  ].join("\n");
}

function runOsascriptCommand(script: string): CommandResult {
  const result = spawnSync("osascript", ["-l", "JavaScript", "-e", script], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { status: result.status };
}
