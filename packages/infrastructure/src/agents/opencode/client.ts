/**
 * Minimal OpenCode V1 server client.
 *
 * Only the endpoints the OpenCode plugin needs are modeled here. The server
 * publishes an OpenAPI spec at `/doc`; the shapes below mirror the generated
 * SDK types (`Event`, `SessionStatus`, `Permission`, `GlobalEvent`).
 */

export type OpenCodeSessionStatus = "idle" | "retry" | "busy";

export type OpenCodeHealth = {
  healthy: boolean;
  version: string;
};

/** A normalized bus event: `payload` mirrors the OpenCode `Event` union. */
export type OpenCodeEvent = {
  type: string;
  properties: Record<string, unknown>;
  /** Present on `/global/event`; the project directory the event belongs to. */
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

export type OpenCodeClientOptions = {
  request?: OpenCodeRequest;
  onLog?: OpenCodeLog;
};

/** Thrown when the SSE stream is closed or the server becomes unreachable. */
export class OpenCodeStreamClosedError extends Error {
  public readonly retryable = true;

  public constructor(message = "OpenCode event stream closed") {
    super(message);
    this.name = "OpenCodeStreamClosedError";
  }
}

const openCodeJsonHeaders = { Accept: "application/json", "Content-Type": "application/json" };

export class OpenCodeClient {
  private readonly request: OpenCodeRequest;

  public constructor(
    private readonly baseUrl: string,
    private readonly options: OpenCodeClientOptions = {},
  ) {
    this.request = options.request ?? ((url, init) => fetch(url, init));
  }

  public async health(): Promise<OpenCodeHealth | undefined> {
    const response = await this.get("/global/health");
    if (!response.ok) return undefined;
    const body = await safeJson(response);
    const healthy = objectValue(body)?.healthy === true;
    const version = stringValue(objectValue(body)?.version) ?? "";
    return healthy ? { healthy, version } : undefined;
  }

  /**
   * Create a session on the server. The server derives the session ID; an
   * optional `title` is stored as the session title so the session is
   * recognizable in the OpenCode TUI and `session list`.
   */
  public async createSession(title?: string): Promise<string | undefined> {
    const response = await this.request(`${this.baseUrl}/session`, {
      method: "POST",
      headers: openCodeJsonHeaders,
      body: title ? JSON.stringify({ title }) : "{}",
    });
    if (!response.ok) return undefined;
    const body = await safeJson(response);
    return stringValue(objectValue(body)?.id);
  }

  /**
   * Rename an existing session. Best effort: returns false when the server
   * rejects the update (for example an older server without title support).
   */
  public async setSessionTitle(sessionId: string, title: string): Promise<boolean> {
    const response = await this.request(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: openCodeJsonHeaders,
      body: JSON.stringify({ title }),
    });
    if (!response.ok) {
      this.options.onLog?.("warn", "opencode.session_title_update_failed", { sessionId });
      return false;
    }
    return true;
  }

  public async sessionExists(sessionId: string): Promise<boolean> {
    const response = await this.get(`/session/${encodeURIComponent(sessionId)}`);
    return response.ok;
  }

  /** Current status of one session, or `undefined` when it cannot be determined. */
  public async sessionStatus(sessionId: string): Promise<OpenCodeSessionStatus | undefined> {
    const response = await this.get("/session/status");
    if (!response.ok) return undefined;
    const body = await safeJson(response);
    const entry = objectValue(body)?.[sessionId];
    return sessionStatusValue(entry);
  }

  public async abortSession(sessionId: string): Promise<boolean> {
    const response = await this.request(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
      headers: openCodeJsonHeaders,
    });
    if (!response.ok) return false;
    const body = await safeJson(response);
    return body === true;
  }

  public async replyPermission(
    sessionId: string,
    permissionId: string,
    response: "allow" | "deny",
    remember = false,
  ): Promise<boolean> {
    const result = await this.request(
      `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
      {
        method: "POST",
        headers: openCodeJsonHeaders,
        body: JSON.stringify({ response, remember }),
      },
    );
    if (!result.ok) return false;
    const body = await safeJson(result);
    return body === true;
  }

  public async forkSession(sessionId: string): Promise<string | undefined> {
    const response = await this.request(`${this.baseUrl}/session/${encodeURIComponent(sessionId)}/fork`, {
      method: "POST",
      headers: openCodeJsonHeaders,
      body: "{}",
    });
    if (!response.ok) return undefined;
    const body = await safeJson(response);
    return stringValue(objectValue(body)?.id);
  }

  /**
   * Open the `/global/event` SSE stream. Events are normalized into
   * `OpenCodeEvent`; malformed chunks are skipped. The generator ends by
   * throwing `OpenCodeStreamClosedError` so callers can reconnect.
   * Pass a signal to abort the connection so the socket is released.
   */
  public async *events(signal?: AbortSignal): AsyncGenerator<OpenCodeEvent> {
    const response = await this.request(`${this.baseUrl}/global/event`, {
      headers: { Accept: "text/event-stream" },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      throw new OpenCodeStreamClosedError(`OpenCode event stream returned ${response.status}`);
    }
    if (!response.body) {
      throw new OpenCodeStreamClosedError("OpenCode event stream has no body");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = findEventBoundary(buffer);
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 1);
          const event = parseSseBlock(block);
          if (event) yield event;
          boundary = findEventBoundary(buffer);
        }
      }
    } catch (error) {
      if (error instanceof OpenCodeStreamClosedError) throw error;
      throw new OpenCodeStreamClosedError(
        `OpenCode event stream failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      reader.releaseLock();
    }
    throw new OpenCodeStreamClosedError("OpenCode event stream ended");
  }

  private async get(path: string): Promise<Response> {
    try {
      return await this.request(`${this.baseUrl}${path}`, { headers: openCodeJsonHeaders });
    } catch (error) {
      this.options.onLog?.("debug", "opencode.request_failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
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
  let eventName: string | undefined;
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) eventName = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
  }
  const data = dataLines.join("\n").trim();
  if (!data) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  return normalizeSsePayload(parsed, eventName);
}

/**
 * The server streams either the raw `Event` (`{ type, properties }`) or the
 * global envelope `GlobalEvent` (`{ directory, payload }`). Both shapes are
 * accepted; the normalized event is derived from the payload.
 */
function normalizeSsePayload(parsed: unknown, eventName: string | undefined): OpenCodeEvent | undefined {
  const object = objectValue(parsed);
  if (!object) return undefined;
  const payload = objectValue(object.payload) ?? object;
  const type = stringValue(payload.type) ?? eventName;
  if (!type) return undefined;
  const properties = objectValue(payload.properties) ?? objectValue(payload);
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

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
