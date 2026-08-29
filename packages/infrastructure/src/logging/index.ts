import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const logLevels = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof logLevels)[number];
export type LogMode = "attached" | "background";
export type LogFormat = "human" | "json";

export type LogValue = string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };

/** Values accepted from callers before they are normalized for a sink. */
export type LogContext = Record<string, unknown>;

export type LogRecord = {
  timestamp: string;
  level: LogLevel;
  service: string;
  pid: number;
  processInstanceId: string;
  mode: LogMode;
  event: string;
  context: Record<string, LogValue>;
  fields: Record<string, LogValue>;
};

export type LogSink = {
  write(record: LogRecord): void;
  close?(): void;
};

export type LoggerOptions = {
  service: string;
  mode: LogMode;
  level: LogLevel;
  sink?: LogSink;
  output?: NodeJS.WritableStream;
  format?: LogFormat;
  showStack?: boolean;
  logFile?: string;
  processInstanceId?: string;
  pid?: number;
  clock?: () => Date;
  maxBytes?: number;
  maxFiles?: number;
};

export type Logger = {
  readonly service: string;
  readonly level: LogLevel;
  child(context: LogContext): Logger;
  isEnabled(level: LogLevel): boolean;
  log(level: LogLevel, event: string, fields?: LogContext): void;
  error(event: string, fields?: LogContext): void;
  warn(event: string, fields?: LogContext): void;
  info(event: string, fields?: LogContext): void;
  debug(event: string, fields?: LogContext): void;
  close(): void;
};

const levelWeights: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const sensitiveKeyPattern =
  /(?:password|passphrase|secret|token|api[-_]?key|authorization|cookie|prompt|headers?|argv|args|environment|env|stdin|stdout|stderr|body|content)/i;
const diagnosticSecretPattern =
  /\b(authorization|cookie|password|passphrase|secret|token|api[-_]?key)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi;
const maxValueDepth = 6;
const maxStringLength = 4_096;

export function createLogger(options: LoggerOptions): Logger {
  const processInstanceId = options.processInstanceId ?? randomUUID();
  const sink = options.sink ?? createDefaultSink(options);
  return new StructuredLogger({
    ...options,
    processInstanceId,
    pid: options.pid ?? process.pid,
    sink,
  });
}

export function createDefaultSink(
  options: Pick<
    LoggerOptions,
    "mode" | "output" | "format" | "logFile" | "maxBytes" | "maxFiles" | "showStack" | "level"
  >,
): LogSink {
  if (options.logFile) {
    return createFileSinkOrFallback(options.logFile, options);
  }
  if (options.mode === "background") {
    return createFileSinkOrFallback(defaultLogFile(), options);
  }
  return createStreamSink(
    options.output ?? process.stderr,
    options.format ?? "human",
    options.showStack ?? options.level === "debug",
  );
}

function createFileSinkOrFallback(
  path: string,
  options: Pick<LoggerOptions, "mode" | "output" | "showStack" | "level" | "maxBytes" | "maxFiles">,
): LogSink {
  try {
    return createRotatingFileSink(path, {
      maxBytes: options.maxBytes,
      maxFiles: options.maxFiles,
    });
  } catch {
    // Logging configuration must not make the command or daemon unusable.
    // Attached processes retain a visible diagnostic fallback; detached
    // processes use a no-op sink because their standard streams are ignored.
    if (options.mode === "attached") {
      return createStreamSink(
        options.output ?? process.stderr,
        "human",
        options.showStack ?? options.level === "debug",
      );
    }
    return { write() {} };
  }
}

export function createStreamSink(
  output: NodeJS.WritableStream,
  format: LogFormat = "human",
  showStack = false,
): LogSink {
  let disabled = false;
  const streamWithEvents = output as NodeJS.WritableStream & {
    on?: (event: "error", listener: () => void) => unknown;
  };
  streamWithEvents.on?.("error", () => {
    disabled = true;
  });

  return {
    write(record) {
      if (disabled) return;
      const value = format === "json" ? `${JSON.stringify(record)}\n` : `${formatHumanRecord(record, showStack)}\n`;
      try {
        output.write(value, "utf8", (error?: Error | null) => {
          if (error) disabled = true;
        });
      } catch {
        // Logging must never change the command's result.
        disabled = true;
      }
    },
  };
}

export function createRotatingFileSink(file: string, options: { maxBytes?: number; maxFiles?: number } = {}): LogSink {
  const path = resolve(file);
  const maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
  const maxFiles = Math.max(1, options.maxFiles ?? 3);
  prepareLogFile(path);

  return {
    write(record) {
      const line = `${JSON.stringify(record)}\n`;
      try {
        rotateIfNeeded(path, Buffer.byteLength(line), maxBytes, maxFiles);
        appendSecure(path, line);
      } catch {
        // A diagnostic sink is best effort. The process must remain usable if
        // a log path becomes unavailable after startup.
      }
    },
  };
}

export function parseLogLevel(value: string | undefined, fallback: LogLevel = "warn"): LogLevel {
  if (value && isLogLevel(value)) return value;
  return fallback;
}

export function defaultLogFile(environment: NodeJS.ProcessEnv = process.env): string {
  return resolve(
    environment.MUXIMO_LOG_FILE ?? join(environment.HOME ?? homedir(), ".local", "state", "muximo", "muximod.log"),
  );
}

export * from "./daemon-log.js";

export function errorFields(error: unknown): LogContext {
  let normalized: LogValue = "[UNAVAILABLE]";
  try {
    normalized = normalizeError(error);
  } catch {
    // Diagnostics must never replace the original error path, including for
    // hostile thrown values such as revoked proxies or throwing accessors.
  }
  return {
    error: normalized,
    errorId: safeShortId(),
  };
}

export function errorMessage(error: unknown): string {
  try {
    const value = error instanceof Error ? error.message : String(error);
    return redactDiagnosticText(value);
  } catch {
    return "unknown error";
  }
}

export function errorName(error: unknown): string {
  try {
    return error instanceof Error && error.name ? String(error.name) : "Error";
  } catch {
    return "Error";
  }
}

export function formatHumanRecord(record: LogRecord, showStack = false): string {
  const prefix = `${record.timestamp} ${record.level.toUpperCase()} [${record.service}] [pid=${record.pid}] ${record.event}`;
  const allFields = { ...record.context, ...record.fields };
  const message = typeof allFields.message === "string" ? allFields.message : undefined;
  delete allFields.message;
  const fields = flattenHumanFields(allFields, showStack, Boolean(message));
  return `${prefix}${message ? ` ${message}` : ""}${fields.length ? ` ${fields.join(" ")}` : ""}`;
}

class StructuredLogger implements Logger {
  public readonly service: string;
  public readonly level: LogLevel;
  private readonly mode: LogMode;
  private readonly pid: number;
  private readonly processInstanceId: string;
  private readonly context: Record<string, LogValue>;
  private readonly sink: LogSink;
  private readonly clock: () => Date;

  public constructor(
    options: LoggerOptions & { processInstanceId: string; pid: number; sink: LogSink },
    context: LogContext = {},
  ) {
    this.service = options.service;
    this.level = options.level;
    this.mode = options.mode;
    this.pid = options.pid;
    this.processInstanceId = options.processInstanceId;
    this.context = sanitizeContext(context);
    this.sink = options.sink;
    this.clock = options.clock ?? (() => new Date());
  }

  public child(context: LogContext): Logger {
    return new StructuredLogger(
      {
        service: this.service,
        mode: this.mode,
        level: this.level,
        processInstanceId: this.processInstanceId,
        pid: this.pid,
        sink: this.sink,
        clock: this.clock,
      },
      { ...this.context, ...context },
    );
  }

  public isEnabled(level: LogLevel): boolean {
    return levelWeights[level] <= levelWeights[this.level];
  }

  public log(level: LogLevel, event: string, fields: LogContext = {}): void {
    if (!this.isEnabled(level)) return;
    const record: LogRecord = {
      timestamp: this.clock().toISOString(),
      level,
      service: this.service,
      pid: this.pid,
      processInstanceId: this.processInstanceId,
      mode: this.mode,
      event,
      context: this.context,
      fields: sanitizeContext(fields),
    };
    try {
      this.sink.write(record);
    } catch {
      // A diagnostic sink is best effort and must not change command behavior.
    }
  }

  public error(event: string, fields?: LogContext): void {
    this.log("error", event, fields);
  }

  public warn(event: string, fields?: LogContext): void {
    this.log("warn", event, fields);
  }

  public info(event: string, fields?: LogContext): void {
    this.log("info", event, fields);
  }

  public debug(event: string, fields?: LogContext): void {
    this.log("debug", event, fields);
  }

  public close(): void {
    try {
      this.sink.close?.();
    } catch {
      // Closing diagnostics is also best effort.
    }
  }
}

function isLogLevel(value: string): value is LogLevel {
  return (logLevels as readonly string[]).includes(value);
}

function sanitizeContext(context: LogContext): Record<string, LogValue> {
  try {
    return sanitizeValue(context, 0, new WeakSet<object>()) as Record<string, LogValue>;
  } catch {
    return { error: "[UNAVAILABLE]" };
  }
}

function sanitizeValue(value: unknown, depth: number, seen: WeakSet<object>, key?: string): LogValue {
  if (key && sensitiveKeyPattern.test(key)) return "[REDACTED]";
  if (value === undefined || value === null || typeof value === "string" || typeof value === "boolean") {
    return typeof value === "string" ? truncate(redactDiagnosticText(value)) : value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (value instanceof Error) return sanitizeError(value, depth, seen);
  if (depth >= maxValueDepth) return "[TRUNCATED]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) {
    try {
      const result = value.slice(0, 32).map((item) => sanitizeValue(item, depth + 1, seen));
      if (value.length > result.length) result.push("[TRUNCATED]");
      return result;
    } catch {
      return "[UNAVAILABLE]";
    }
  }
  const result: Record<string, LogValue> = {};
  try {
    for (const [entryKey, entryValue] of Object.entries(value)) {
      result[entryKey] = sanitizeValue(entryValue, depth + 1, seen, entryKey);
    }
  } catch {
    return "[UNAVAILABLE]";
  }
  return result;
}

function sanitizeError(error: Error, depth: number, seen: WeakSet<object>): Record<string, LogValue> {
  const name = safeErrorProperty(error, "name", "Error");
  const message = redactDiagnosticText(safeErrorProperty(error, "message", "unknown error"));
  const result: Record<string, LogValue> = {
    name,
    message: truncate(message),
  };
  const code = safeErrorProperty(error, "code", undefined);
  if (typeof code === "string" || typeof code === "number") result.code = code;
  const stack = safeErrorProperty(error, "stack", undefined);
  if (stack) {
    result.stack = truncate(
      isSubprocessDiagnostic(message) ? `${name}: ${message}` : redactDiagnosticText(stack),
      16_384,
    );
  }
  if (depth < maxValueDepth) {
    const cause = safeErrorProperty(error, "cause", undefined);
    if (cause !== undefined) result.cause = sanitizeValue(cause, depth + 1, seen);
  }
  return result;
}

function normalizeError(error: unknown): LogValue {
  return sanitizeValue(error, 0, new WeakSet<object>());
}

function truncate(value: string, limit = maxStringLength): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function shortId(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

function safeShortId(): string {
  try {
    return shortId();
  } catch {
    return "unknown";
  }
}

function safeErrorProperty(error: Error, property: string, fallback: string | number | undefined): string {
  try {
    const value = (error as unknown as Record<string, unknown>)[property];
    return value === undefined || value === null ? String(fallback ?? "") : String(value);
  } catch {
    return String(fallback ?? "");
  }
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/\bCommand failed:[\s\S]*/gi, "Command failed: [REDACTED]")
    .replace(/(--(?:prompt|token|secret|password|api[-_]?key))(?:=|\s+)("[^"]*"|'[^']*'|\S+)/gi, "$1=[REDACTED]")
    .replace(diagnosticSecretPattern, "$1=[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
}

function isSubprocessDiagnostic(message: string): boolean {
  return /\bCommand failed:|^spawn\s+\S+\s+(?:ENOENT|EACCES|EPERM)\b|^could not run\s+/i.test(message);
}

function flattenHumanFields(fields: Record<string, LogValue>, showStack: boolean, hasMessage = false): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (key === "error" && isLogObject(value)) {
      if (!hasMessage && typeof value.message === "string") values.push(`error=${quote(value.message)}`);
      if (showStack && typeof value.stack === "string") values.push(`stack=${quote(value.stack)}`);
      continue;
    }
    if (key === "stack" && !showStack) continue;
    if (value === undefined) continue;
    values.push(`${key}=${formatHumanValue(value)}`);
  }
  return values;
}

function isLogObject(value: LogValue): value is { [key: string]: LogValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatHumanValue(value: LogValue): string {
  if (typeof value === "string") return quote(value);
  if (typeof value === "object" && value !== null) return quote(JSON.stringify(value));
  return String(value);
}

function quote(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function prepareLogFile(path: string): void {
  ensureLogDirectory(dirname(path));
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`log path must not be a symbolic link: ${path}`);
    if (!stat.isFile()) throw new Error(`log path is not a regular file: ${path}`);
    chmodSync(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    appendSecure(path, "");
  }
}

function ensureLogDirectory(path: string): void {
  const created: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    created.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const directory of created) chmodSync(directory, 0o700);
}

function appendSecure(path: string, value: string): void {
  const noFollow = (constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`log path is not a regular file: ${path}`);
    chmodSync(path, 0o600);
    if (value) writeSync(fd, value, undefined, "utf8");
  } finally {
    closeSync(fd);
  }
}

function rotateIfNeeded(path: string, incomingBytes: number, maxBytes: number, maxFiles: number): void {
  if (!existsSync(path)) return;
  const size = statSync(path).size;
  if (size + incomingBytes <= maxBytes) return;
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const source = `${path}.${index}`;
    const target = `${path}.${index + 1}`;
    if (!existsSync(source)) continue;
    try {
      renameSync(source, target);
    } catch {
      // Preserve the active log if an old generation cannot be moved.
    }
  }
  try {
    renameSync(path, `${path}.1`);
  } catch {
    // The next append still contains the diagnostic event.
  }
}
