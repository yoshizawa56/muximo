import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { resolve } from "node:path";
import { defaultLogFile } from "./index.js";

export type DaemonLogResult = {
  state: "available" | "empty" | "missing";
  logFile: string;
  lines: readonly string[];
};

// Leave enough room below the control response limit for JSON escaping and
// response metadata after these lines cross the process boundary.
export const maxDaemonLogReadBytes = 512 * 1024;
const maxDaemonLogLineBytes = 64 * 1024;

/** Reads a bounded diagnostic tail inside the daemon's infrastructure boundary. */
export function readDaemonLog(logFile: string | undefined, lineCount = 100): DaemonLogResult {
  if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 10_000) {
    throw new Error("daemon log line count must be between 1 and 10000");
  }

  const path = resolve(logFile ?? defaultLogFile());
  let contents: string;
  try {
    contents = readLogTail(path);
  } catch (error) {
    if (isFileNotFoundError(error)) return { state: "missing", logFile: path, lines: [] };
    throw new Error(`muximod log file could not be read: ${path}`, { cause: error });
  }

  const lines = limitLogLines(
    contents
      .split(/\r?\n/)
      .filter((line) => line.length > 0)
      .slice(-lineCount),
  );
  return {
    state: lines.length === 0 ? "empty" : "available",
    logFile: path,
    lines,
  };
}

function readLogTail(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    if (size === 0) return "";
    const start = Math.max(0, size - maxDaemonLogReadBytes);
    const buffer = Buffer.alloc(size - start);
    let offset = 0;
    while (offset < buffer.length) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, start + offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    let value = buffer.subarray(0, offset).toString("utf8");
    if (start > 0) {
      const firstLineBreak = value.indexOf("\n");
      value = firstLineBreak < 0 ? value : value.slice(firstLineBreak + 1);
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}

function limitLogLines(lines: readonly string[]): string[] {
  const result: string[] = [];
  let totalBytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = truncateLogLine(lines[index] ?? "");
    const lineBytes = Buffer.byteLength(line, "utf8");
    const separatorBytes = result.length > 0 ? 1 : 0;
    if (result.length > 0 && totalBytes + separatorBytes + lineBytes > maxDaemonLogReadBytes) break;
    result.unshift(line);
    totalBytes += separatorBytes + lineBytes;
  }
  return result;
}

function truncateLogLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= maxDaemonLogLineBytes) return line;
  const value = Buffer.from(line, "utf8")
    .subarray(0, maxDaemonLogLineBytes - 4)
    .toString("utf8");
  return `${value}...`;
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
