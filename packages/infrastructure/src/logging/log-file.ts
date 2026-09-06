import { closeSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { formatHumanRecord, type LogLevel, type LogRecord, type LogValue, logLevels } from "./index.js";

export type MuximodLogFileLine = {
  raw: string;
  record: LogRecord | undefined;
};

export type MuximodLogFileReadResult = {
  state: "available" | "empty" | "missing";
  logFile: string;
  lines: readonly MuximodLogFileLine[];
};

export type MuximodLogFileFollowOptions = {
  logFile: string;
  filter?: string;
  pollIntervalMs?: number;
  signal: AbortSignal;
  onLines: (lines: readonly MuximodLogFileLine[]) => void;
};

export const maxMuximodLogTailBytes = 8 * 1024 * 1024;
const maxMuximodLogLineBytes = 64 * 1024;
export const defaultMuximodLogFollowIntervalMs = 500;

/** Parses one muximod JSON log line; unparseable lines are preserved as raw text. */
export function parseMuximodLogFileLine(raw: string): MuximodLogFileLine {
  return { raw, record: parseLogRecord(raw) };
}

/** Matches lines case-insensitively against their rendered text and raw JSON. */
export function compileMuximodLogFilter(pattern: string): (line: MuximodLogFileLine) => boolean {
  const needle = pattern.toLowerCase();
  return (line) => {
    if (line.raw.toLowerCase().includes(needle)) return true;
    const rendered = line.record ? formatHumanRecord(line.record) : line.raw;
    return rendered.toLowerCase().includes(needle);
  };
}

/** Reads a bounded tail directly from the muximod log file without contacting the daemon. */
export function readMuximodLogFile(options: {
  logFile: string;
  lines?: number;
  filter?: string;
}): MuximodLogFileReadResult {
  const lineCount = options.lines ?? 100;
  if (!Number.isInteger(lineCount) || lineCount < 1 || lineCount > 10_000) {
    throw new Error("daemon log line count must be between 1 and 10000");
  }

  const path = resolve(options.logFile);
  let contents: string;
  try {
    contents = readLogTail(path);
  } catch (error) {
    if (isFileNotFoundError(error)) return { state: "missing", logFile: path, lines: [] };
    throw new Error(`muximod log file could not be read: ${path}`, { cause: error });
  }

  const matcher = options.filter === undefined ? undefined : compileMuximodLogFilter(options.filter);
  const matching = contents
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map(parseMuximodLogFileLine)
    .filter((line) => !matcher || matcher(line));
  const lines = limitLogLines(matching.slice(-lineCount));
  return { state: lines.length === 0 ? "empty" : "available", logFile: path, lines };
}

/**
 * Streams new log lines appended after the current end of the file until the
 * signal aborts. Rotation and truncation are detected and the file is
 * re-read from its beginning; a missing file is polled until it appears.
 */
export async function followMuximodLogFile(options: MuximodLogFileFollowOptions): Promise<void> {
  const path = resolve(options.logFile);
  const pollIntervalMs = options.pollIntervalMs ?? defaultMuximodLogFollowIntervalMs;
  const matcher = options.filter === undefined ? undefined : compileMuximodLogFilter(options.filter);
  let inode: number | undefined;
  let position = 0;
  let pending: Buffer = Buffer.alloc(0);

  // Start at the current end of the file so the caller decides what history to show.
  try {
    const stats = statSync(path);
    if (stats.isFile()) {
      inode = stats.ino;
      position = stats.size;
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }

  while (!options.signal.aborted) {
    await delay(pollIntervalMs, options.signal);
    if (options.signal.aborted) return;

    let size: number;
    try {
      const stats = statSync(path);
      if (!stats.isFile()) throw new Error(`muximod log path is not a regular file: ${path}`);
      size = stats.size;
      if (inode !== undefined && stats.ino !== inode) {
        inode = stats.ino;
        position = 0;
        pending = Buffer.alloc(0);
      } else {
        inode = stats.ino;
      }
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
      inode = undefined;
      position = 0;
      pending = Buffer.alloc(0);
      continue;
    }
    if (size < position) {
      position = 0;
      pending = Buffer.alloc(0);
    }
    if (size === position) continue;

    const chunk = readSegment(path, position, size - position);
    if (chunk === undefined) continue;
    position += chunk.length;
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);

    const ready: MuximodLogFileLine[] = [];
    let boundary = pending.indexOf(0x0a);
    while (boundary >= 0) {
      const raw = pending.subarray(0, boundary).toString("utf8");
      pending = pending.subarray(boundary + 1);
      boundary = pending.indexOf(0x0a);
      if (raw.length === 0) continue;
      const line = truncateLine(parseMuximodLogFileLine(raw));
      if (!matcher || matcher(line)) ready.push(line);
    }
    if (ready.length > 0) options.onLines(ready);
  }
}

function parseLogRecord(raw: string): LogRecord | undefined {
  if (!raw.startsWith("{")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const level = typeof record.level === "string" && isLogLevel(record.level) ? record.level : undefined;
  if (level === undefined) return undefined;
  if (typeof record.timestamp !== "string" || typeof record.service !== "string" || typeof record.event !== "string") {
    return undefined;
  }
  return {
    timestamp: record.timestamp,
    level,
    service: record.service,
    pid: typeof record.pid === "number" ? record.pid : process.pid,
    processInstanceId: typeof record.processInstanceId === "string" ? record.processInstanceId : "",
    mode: record.mode === "attached" ? "attached" : "background",
    event: record.event,
    context: readRecordObject(record.context),
    fields: readRecordObject(record.fields),
  };
}

function readRecordObject(value: unknown): Record<string, LogValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, LogValue>;
}

function isLogLevel(value: string): value is LogLevel {
  return (logLevels as readonly string[]).includes(value);
}

function readLogTail(path: string): string {
  const descriptor = openSync(path, "r");
  try {
    const size = fstatSync(descriptor).size;
    if (size === 0) return "";
    const start = Math.max(0, size - maxMuximodLogTailBytes);
    const buffer = readSegmentByDescriptor(descriptor, start, size - start);
    if (buffer === undefined) return "";
    let value = buffer.toString("utf8");
    if (start > 0) {
      const firstLineBreak = value.indexOf("\n");
      value = firstLineBreak < 0 ? "" : value.slice(firstLineBreak + 1);
    }
    return value;
  } finally {
    closeSync(descriptor);
  }
}

function readSegment(path: string, start: number, length: number): Buffer | undefined {
  const descriptor = openSync(path, "r");
  try {
    return readSegmentByDescriptor(descriptor, start, length);
  } finally {
    closeSync(descriptor);
  }
}

function readSegmentByDescriptor(descriptor: number, start: number, length: number): Buffer | undefined {
  if (length <= 0) return undefined;
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, start + offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === 0 ? undefined : buffer.subarray(0, offset);
}

function limitLogLines(lines: readonly MuximodLogFileLine[]): MuximodLogFileLine[] {
  const result: MuximodLogFileLine[] = [];
  let totalBytes = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = truncateLine(lines[index] ?? { raw: "", record: undefined });
    const lineBytes = Buffer.byteLength(line.raw, "utf8");
    const separatorBytes = result.length > 0 ? 1 : 0;
    if (result.length > 0 && totalBytes + separatorBytes + lineBytes > maxMuximodLogTailBytes) break;
    result.unshift(line);
    totalBytes += separatorBytes + lineBytes;
  }
  return result;
}

function truncateLine(line: MuximodLogFileLine): MuximodLogFileLine {
  if (Buffer.byteLength(line.raw, "utf8") <= maxMuximodLogLineBytes) return line;
  const value = Buffer.from(line.raw, "utf8")
    .subarray(0, maxMuximodLogLineBytes - 4)
    .toString("utf8");
  return { raw: `${value}...`, record: undefined };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePromise) => {
    if (signal.aborted) {
      resolvePromise();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolvePromise();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
