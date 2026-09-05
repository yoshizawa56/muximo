/**
 * Minimal OpenCode V1 server client.
 *
 * Only the endpoints the OpenCode plugin needs are modeled here. The server
 * publishes an OpenAPI spec at `/doc`; the shapes below mirror the generated
 * SDK types (`Event`, `SessionStatus`, `Permission`, `GlobalEvent`).
 */

import { Effect, Stream } from "effect";
import { fromPromise } from "../../effect.js";

export type OpenCodeSessionStatus = "idle" | "retry" | "busy";

export type OpenCodeHealth = {
  healthy: boolean;
  version: string;
};

/** A normalized bus event from the OpenCode global event envelope. */
export type OpenCodeEvent = {
  type: string;
  properties: Record<string, unknown>;
  /** The project directory the event belongs to. */
  directory?: string;
};

export type OpenCodePermission = {
  id?: string;
  type?: string;
  pattern?: string | string[];
  sessionID?: string;
  messageID?: string;
  callID?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};

export type OpenCodeLog = (
  level: "debug" | "info" | "warn" | "error",
  message: string,
  extra?: Record<string, unknown>,
) => void;

export type OpenCodeRequest = (url: string, init?: RequestInit) => Promise<Response>;

export class OpenCodeTransportError extends Error {
  public readonly _tag = "OpenCodeTransportError" as const;
  public readonly retryable = false;

  public constructor(cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message);
    this.name = "OpenCodeTransportError";
    this.cause = cause;
  }
}

export type OpenCodeClientOptions = {
  request?: OpenCodeRequest;
  onLog?: OpenCodeLog;
  /** Routes requests to the OpenCode instance for this workspace. */
  directory?: string;
  /** Maximum duration for one short-lived JSON request. */
  requestTimeoutMs?: number;
};

/** Thrown when the SSE stream is closed or the server becomes unreachable. */
export class OpenCodeStreamClosedError extends Error {
  public readonly _tag = "OpenCodeStreamClosedError" as const;
  public readonly retryable = true;

  public constructor(message = "OpenCode event stream closed") {
    super(message);
    this.name = "OpenCodeStreamClosedError";
  }
}

const openCodeJsonHeaders = { Accept: "application/json", "Content-Type": "application/json" };
export const openCodeRequestTimeoutMs = 5_000;
export const openCodeResponseMaxBytes = 4 * 1024 * 1024;

export class OpenCodeRequestTimeoutError extends Error {
  public readonly _tag = "OpenCodeRequestTimeoutError" as const;
  public readonly retryable = true;

  public constructor(
    public readonly url: string,
    public readonly timeoutMs: number,
  ) {
    super(`OpenCode request timed out after ${timeoutMs}ms: ${url}`);
    this.name = "OpenCodeRequestTimeoutError";
  }
}

export class OpenCodeResponseTooLargeError extends Error {
  public readonly _tag = "OpenCodeResponseTooLargeError" as const;
  public readonly retryable = false;

  public constructor(
    public readonly url: string,
    public readonly maxBytes: number,
  ) {
    super(`OpenCode response exceeded the ${maxBytes}-byte limit: ${url}`);
    this.name = "OpenCodeResponseTooLargeError";
  }
}

export type OpenCodeClientError =
  | OpenCodeRequestTimeoutError
  | OpenCodeResponseTooLargeError
  | OpenCodeStreamClosedError
  | OpenCodeTransportError;

type OpenCodeEffect<A> = Effect.Effect<A, OpenCodeClientError>;

type RequestResources = {
  controller: AbortController;
  sourceSignal: AbortSignal | undefined;
  abortSource: (() => void) | undefined;
  timer: ReturnType<typeof setTimeout>;
  abort: Promise<never> | undefined;
  timeout: Promise<never>;
};

/**
 * Bounds a short-lived request and aborts the underlying fetch when possible.
 * The promise race also protects callers that inject a request implementation
 * which does not observe AbortSignal.
 */
export function requestWithTimeout(
  request: OpenCodeRequest,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
): OpenCodeEffect<Response> {
  const sourceSignal = init?.signal ?? undefined;
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const controller = new AbortController();
      let abortSource: (() => void) | undefined;
      let abort: Promise<never> | undefined;
      if (sourceSignal !== undefined) {
        let rejectAbort!: (reason: unknown) => void;
        abort = new Promise<never>((_, reject) => {
          rejectAbort = reject;
        });
        abortSource = () => {
          controller.abort(sourceSignal.reason);
          rejectAbort(
            sourceSignal.reason instanceof Error ? sourceSignal.reason : new Error("OpenCode request aborted"),
          );
        };
        if (sourceSignal.aborted) abortSource();
        else sourceSignal.addEventListener("abort", abortSource, { once: true });
      }

      let rejectTimeout!: (reason: unknown) => void;
      const timeout = new Promise<never>((_, reject) => {
        rejectTimeout = reject;
      });
      const timer = setTimeout(
        () => {
          controller.abort();
          rejectTimeout(new OpenCodeRequestTimeoutError(url, timeoutMs));
        },
        Math.max(0, timeoutMs),
      );
      return { controller, sourceSignal, abortSource, timer, abort, timeout } satisfies RequestResources;
    }),
    (resources) => {
      const requestEffect = fromOpenCodePromise(() =>
        request(url, { ...init, signal: resources.controller.signal }),
      ).pipe(
        Effect.flatMap((response) => readResponseBody(response, url).pipe(Effect.map((body) => ({ response, body })))),
        Effect.map(
          ({ response, body }) =>
            new Response(body, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            }),
        ),
      );
      const timeoutEffect = fromPromise(() => resources.timeout).pipe(Effect.mapError(toOpenCodeClientError));
      if (resources.abort === undefined) return Effect.raceFirst(requestEffect, timeoutEffect);
      // Abort reasons belong to the caller's signal. Preserve the original
      // reason rather than translating it into a transport error.
      const abortEffect = fromPromise(() => resources.abort as Promise<never>).pipe(
        Effect.mapError((error) => error as OpenCodeClientError),
      );
      return Effect.raceFirst(requestEffect, Effect.raceFirst(timeoutEffect, abortEffect));
    },
    (resources) =>
      Effect.sync(() => {
        clearTimeout(resources.timer);
        if (resources.abortSource !== undefined)
          resources.sourceSignal?.removeEventListener("abort", resources.abortSource);
        resources.controller.abort();
      }),
  );
}

function readResponseBody(response: Response, url: string): OpenCodeEffect<ArrayBuffer> {
  const responseBody = response.body;
  if (!responseBody) {
    return Effect.gen(function* () {
      const body = yield* fromOpenCodePromise(() => response.arrayBuffer());
      if (body.byteLength > openCodeResponseMaxBytes) {
        return yield* Effect.fail(new OpenCodeResponseTooLargeError(url, openCodeResponseMaxBytes));
      }
      return body;
    });
  }
  return Effect.acquireUseRelease(
    Effect.sync(() => responseBody.getReader()),
    (reader) =>
      Effect.gen(function* () {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const { done, value } = yield* fromOpenCodePromise(() => reader.read());
          if (done) break;
          if (value === undefined) continue;
          size += value.byteLength;
          if (size > openCodeResponseMaxBytes) {
            yield* fromOpenCodePromise(() => reader.cancel());
            return yield* Effect.fail(new OpenCodeResponseTooLargeError(url, openCodeResponseMaxBytes));
          }
          chunks.push(value);
        }
        const body = new ArrayBuffer(size);
        const view = new Uint8Array(body);
        let offset = 0;
        for (const chunk of chunks) {
          view.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return body;
      }),
    (reader) => Effect.sync(() => reader.releaseLock()),
  );
}

export class OpenCodeClient {
  private readonly request: OpenCodeRequest;
  private readonly requestTimeoutMs: number;

  public constructor(
    private readonly baseUrl: string,
    private readonly options: OpenCodeClientOptions = {},
  ) {
    this.request = options.request ?? ((url, init) => fetch(url, init));
    this.requestTimeoutMs = Math.max(0, options.requestTimeoutMs ?? openCodeRequestTimeoutMs);
  }

  public health(signal?: AbortSignal): OpenCodeEffect<OpenCodeHealth | undefined> {
    const client = this;
    return Effect.gen(function* () {
      const response = yield* client.get("/global/health", signal);
      if (!response.ok) return undefined;
      const body = yield* safeJson(response);
      const healthy = objectValue(body)?.healthy === true;
      const version = stringValue(objectValue(body)?.version) ?? "";
      return healthy ? { healthy, version } : undefined;
    });
  }

  /** Creates a session and optionally sets its title. */
  public createSession(title?: string, signal?: AbortSignal): OpenCodeEffect<string | undefined> {
    const client = this;
    return Effect.gen(function* () {
      const response = yield* client.requestWithTimeout(`${client.baseUrl}/session`, {
        method: "POST",
        headers: client.headers(openCodeJsonHeaders),
        body: title ? JSON.stringify({ title }) : "{}",
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) return undefined;
      const body = yield* safeJson(response);
      return stringValue(objectValue(body)?.id);
    });
  }

  /** Renames an existing session. */
  public setSessionTitle(sessionId: string, title: string, signal?: AbortSignal): OpenCodeEffect<boolean> {
    const client = this;
    return Effect.gen(function* () {
      const response = yield* client.requestWithTimeout(`${client.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
        method: "PATCH",
        headers: client.headers(openCodeJsonHeaders),
        body: JSON.stringify({ title }),
        ...(signal === undefined ? {} : { signal }),
      });
      if (!response.ok) {
        yield* Effect.sync(() => client.options.onLog?.("warn", "opencode.session_title_update_failed", { sessionId }));
        return false;
      }
      return true;
    });
  }

  public sessionExists(sessionId: string, signal?: AbortSignal): OpenCodeEffect<boolean> {
    const client = this;
    return Effect.gen(function* () {
      const response = yield* client.get(`/session/${encodeURIComponent(sessionId)}`, signal);
      return response.ok;
    });
  }

  /** Current status of one session, or `undefined` when it cannot be determined. */
  public sessionStatus(sessionId: string, signal?: AbortSignal): OpenCodeEffect<OpenCodeSessionStatus | undefined> {
    const client = this;
    return Effect.gen(function* () {
      const response = yield* client.get("/session/status", signal);
      if (!response.ok) return undefined;
      const body = yield* safeJson(response);
      const entry = objectValue(body)?.[sessionId];
      return sessionStatusValue(entry);
    });
  }

  public abortSession(sessionId: string, signal?: AbortSignal): OpenCodeEffect<boolean> {
    const client = this;
    return Effect.gen(function* () {
      const response = yield* client.requestWithTimeout(
        `${client.baseUrl}/session/${encodeURIComponent(sessionId)}/abort`,
        {
          method: "POST",
          headers: client.headers(openCodeJsonHeaders),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (!response.ok) return false;
      const body = yield* safeJson(response);
      return body === true;
    });
  }

  public replyPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember = false,
    signal?: AbortSignal,
  ): OpenCodeEffect<boolean> {
    const client = this;
    return Effect.gen(function* () {
      const result = yield* client.requestWithTimeout(
        `${client.baseUrl}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
        {
          method: "POST",
          headers: client.headers(openCodeJsonHeaders),
          body: JSON.stringify({ response, remember }),
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (!result.ok) return false;
      const body = yield* safeJson(result);
      return body === true;
    });
  }

  public forkSession(sessionId: string, signal?: AbortSignal): OpenCodeEffect<string | undefined> {
    const client = this;
    return Effect.gen(function* () {
      const response = yield* client.requestWithTimeout(
        `${client.baseUrl}/session/${encodeURIComponent(sessionId)}/fork`,
        {
          method: "POST",
          headers: client.headers(openCodeJsonHeaders),
          body: "{}",
          ...(signal === undefined ? {} : { signal }),
        },
      );
      if (!response.ok) return undefined;
      const body = yield* safeJson(response);
      return stringValue(objectValue(body)?.id);
    });
  }

  /**
   * Open the `/global/event` SSE stream. Events are normalized into
   * `OpenCodeEvent`; malformed chunks are skipped. The stream fails with
   * `OpenCodeStreamClosedError` when the connection closes so callers can
   * reconnect.
   * Pass a signal to abort the connection so the socket is released.
   */
  public events(signal?: AbortSignal): Stream.Stream<OpenCodeEvent, OpenCodeClientError> {
    const open = fromOpenCodePromise((effectSignal) =>
      this.request(`${this.baseUrl}/global/event`, {
        headers: this.headers({ Accept: "text/event-stream" }),
        signal: signal ?? effectSignal,
      }),
    ).pipe(
      Effect.flatMap((response) => {
        if (!response.ok)
          return Effect.fail(new OpenCodeStreamClosedError(`OpenCode event stream returned ${response.status}`));
        const responseBody = response.body;
        if (!responseBody) return Effect.fail(new OpenCodeStreamClosedError("OpenCode event stream has no body"));
        return Effect.acquireRelease(
          Effect.sync(() => responseBody.getReader()),
          (reader) => Effect.sync(() => reader.releaseLock()),
        ).pipe(Effect.map((reader) => ({ reader, decoder: new TextDecoder(), buffer: "" })));
      }),
    );
    return Stream.scoped(Stream.unwrap(open.pipe(Effect.map((state) => Stream.unfold(state, readSseEvent)))));
  }

  private get(path: string, signal?: AbortSignal): OpenCodeEffect<Response> {
    return this.requestWithTimeout(`${this.baseUrl}${path}`, {
      headers: this.headers(openCodeJsonHeaders),
      ...(signal === undefined ? {} : { signal }),
    }).pipe(
      Effect.tapError((error) =>
        Effect.sync(() =>
          this.options.onLog?.("debug", "opencode.request_failed", {
            path,
            error: error.message,
          }),
        ),
      ),
    );
  }

  private requestWithTimeout(url: string, init: RequestInit): OpenCodeEffect<Response> {
    return requestWithTimeout(this.request, url, init, this.requestTimeoutMs);
  }

  private headers(headers: Record<string, string>): Record<string, string> {
    return this.options.directory === undefined
      ? headers
      : { ...headers, "x-opencode-directory": this.options.directory };
  }
}

function fromOpenCodePromise<A>(
  evaluate: (signal: AbortSignal) => A | PromiseLike<A>,
): Effect.Effect<A, OpenCodeTransportError> {
  return fromPromise(evaluate).pipe(Effect.mapError((error) => new OpenCodeTransportError(error)));
}

function toOpenCodeClientError(error: Error): OpenCodeClientError {
  return error instanceof OpenCodeRequestTimeoutError ? error : new OpenCodeTransportError(error);
}

type SseReaderState = {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  decoder: TextDecoder;
  buffer: string;
};

function readSseEvent(state: SseReaderState): OpenCodeEffect<readonly [OpenCodeEvent, SseReaderState]> {
  return Effect.gen(function* () {
    for (;;) {
      const boundary = findEventBoundary(state.buffer);
      if (boundary !== -1) {
        const block = state.buffer.slice(0, boundary);
        state.buffer = state.buffer.slice(boundary + 1);
        const event = parseSseBlock(block);
        if (event) return [event, state] as const;
        continue;
      }
      const { done, value } = yield* fromOpenCodePromise(() => state.reader.read());
      if (done) return yield* Effect.fail(new OpenCodeStreamClosedError("OpenCode event stream ended"));
      if (value !== undefined) state.buffer += state.decoder.decode(value, { stream: true });
    }
  });
}

function sessionStatusValue(value: unknown): OpenCodeSessionStatus | undefined {
  const entry = objectValue(value);
  const type = stringValue(entry?.type);
  if (type === "idle" || type === "retry" || type === "busy") return type;
  return undefined;
}

function parseSseBlock(block: string): OpenCodeEvent | undefined {
  const lines = block.replaceAll("\r\n", "\n").split("\n");
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }
  const data = dataLines.join("\n").trim();
  if (!data) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  return normalizeSsePayload(parsed);
}

/** Normalizes the current OpenCode `GlobalEvent` envelope. */
function normalizeSsePayload(parsed: unknown): OpenCodeEvent | undefined {
  const object = objectValue(parsed);
  if (!object) return undefined;
  const payload = objectValue(object.payload);
  if (!payload) return undefined;
  const type = stringValue(payload.type);
  if (!type) return undefined;
  const properties = objectValue(payload.properties);
  if (!properties) return undefined;
  return {
    type,
    properties,
    ...(stringValue(object.directory) ? { directory: stringValue(object.directory) } : {}),
  };
}

function findEventBoundary(buffer: string): number {
  const doubleLineFeed = buffer.indexOf("\n\n");
  if (doubleLineFeed !== -1) return doubleLineFeed;
  const carriageReturnFeed = buffer.indexOf("\r\n\r\n");
  if (carriageReturnFeed !== -1) return carriageReturnFeed;
  return -1;
}

function safeJson(response: Response): Effect.Effect<unknown, never> {
  return fromPromise(() => response.json()).pipe(Effect.catch(() => Effect.succeed(undefined)));
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
