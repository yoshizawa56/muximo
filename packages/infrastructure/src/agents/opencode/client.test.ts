import {
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect, Stream } from "effect";
import { describe, it } from "vitest";
import {
  OpenCodeClient,
  type OpenCodeEvent,
  OpenCodeRequestTimeoutError,
  OpenCodeStreamClosedError,
} from "./client.js";

type SseInput = {
  sseText: string;
  status?: number;
};

type EmptyContext = {};

type SseResult = {
  events: readonly OpenCodeEvent[];
  endedWithStreamClosed: boolean;
  errorStatus?: number;
};

const sseCases = [
  {
    name: "parses global envelope events with their directory",
    input: {
      sseText: [
        'data: {"directory":"/ws","payload":{"type":"session.status","properties":{"sessionID":"s1","status":{"type":"busy"}}}}',
        "",
        "",
      ].join("\n"),
    },
    assert: [
      returns<EmptyContext, SseResult>({
        events: [
          {
            type: "session.status",
            properties: { sessionID: "s1", status: { type: "busy" } },
            directory: "/ws",
          },
        ],
        endedWithStreamClosed: true,
      }),
    ],
  },
  {
    name: "ignores an event without the global envelope",
    input: {
      sseText: ["event: session.idle", 'data: {"sessionID":"s1"}', "", ""].join("\n"),
    },
    assert: [
      returns<EmptyContext, SseResult>({
        events: [],
        endedWithStreamClosed: true,
      }),
    ],
  },
  {
    name: "skips malformed JSON and keeps valid events",
    input: {
      sseText: [
        "data: {not json",
        "",
        'data: {"payload":{"type":"session.idle","properties":{"sessionID":"s1"}}}',
        "",
        "",
      ].join("\n"),
    },
    assert: [
      returns<EmptyContext, SseResult>({
        events: [{ type: "session.idle", properties: { sessionID: "s1" } }],
        endedWithStreamClosed: true,
      }),
    ],
  },
  {
    name: "ignores comment keepalive blocks",
    input: {
      sseText: [": ping", "", 'data: {"payload":{"type":"session.idle","properties":{"sessionID":"s1"}}}', "", ""].join(
        "\n",
      ),
    },
    assert: [
      returns<EmptyContext, SseResult>({
        events: [{ type: "session.idle", properties: { sessionID: "s1" } }],
        endedWithStreamClosed: true,
      }),
    ],
  },
  {
    name: "handles CRLF block separators",
    input: {
      sseText: 'data: {"payload":{"type":"session.idle","properties":{"sessionID":"s1"}}}\r\n\r\n',
    },
    assert: [
      returns<EmptyContext, SseResult>({
        events: [{ type: "session.idle", properties: { sessionID: "s1" } }],
        endedWithStreamClosed: true,
      }),
    ],
  },
  {
    name: "joins multi-line data payloads",
    input: {
      sseText: [
        "event: session.status",
        'data: {"payload":{"type":"session.status","properties":{"sessionID":"s1",',
        'data: "status":{"type":"idle"}}}}',
        "",
        "",
      ].join("\n"),
    },
    assert: [
      returns<EmptyContext, SseResult>({
        events: [
          {
            type: "session.status",
            properties: { sessionID: "s1", status: { type: "idle" } },
          },
        ],
        endedWithStreamClosed: true,
      }),
    ],
  },
  {
    name: "reports a non-200 event stream response",
    input: { sseText: "", status: 500 },
    assert: [returns<EmptyContext, SseResult>({ events: [], endedWithStreamClosed: true, errorStatus: 500 })],
  },
] satisfies readonly OperationCase<"default", SseInput, SseResult, EmptyContext>[];

const sseTable: OperationTable<undefined, "default", SseInput, SseResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: sseCases,
  execute: async (_fixture, input) => {
    const client = new OpenCodeClient("http://127.0.0.1:4096", {
      request: async (_url) => {
        if (input.status !== undefined) return new Response("unavailable", { status: input.status });
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(input.sseText));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    });
    const events: OpenCodeEvent[] = [];
    let endedWithStreamClosed = false;
    let errorStatus: number | undefined;
    try {
      await Effect.runPromise(Stream.runForEach(client.events(), (event) => Effect.sync(() => events.push(event))));
    } catch (error) {
      if (error instanceof OpenCodeStreamClosedError) {
        endedWithStreamClosed = true;
        errorStatus = error.message.includes("returned")
          ? Number.parseInt(error.message.match(/(\d+)/)?.[1] ?? "0", 10)
          : undefined;
      } else {
        throw error;
      }
    }
    return { events, endedWithStreamClosed, errorStatus };
  },
  observe: () => ({}),
};

type CallRecord = { url: string; init: RequestInit | undefined };

type EndpointInput = {
  kind: "health" | "create" | "abort" | "permission" | "fork" | "status" | "title" | "directory" | "timeout";
  sessionId?: string;
  permissionId?: string;
  responseBody?: unknown;
  responseStatus?: number;
  title?: string;
  requestTimeoutMs?: number;
};

type EndpointResult = {
  value: unknown;
  calls: readonly { url: string; method: string; body: string | undefined }[];
  directoryHeader?: string | null;
};

const endpointCases = [
  {
    name: "health returns the server version",
    input: { kind: "health" as const, responseBody: { healthy: true, version: "1.2.3" } },
    assert: [
      returns<EmptyContext, EndpointResult>({
        value: { healthy: true, version: "1.2.3" },
        calls: [{ url: "http://127.0.0.1:4096/global/health", method: "GET", body: undefined }],
      }),
    ],
  },
  {
    name: "create session posts an empty body and returns the session id",
    input: { kind: "create" as const, responseBody: { id: "session-new" } },
    assert: [
      returns<EmptyContext, EndpointResult>({
        value: "session-new",
        calls: [{ url: "http://127.0.0.1:4096/session", method: "POST", body: "{}" }],
      }),
    ],
  },
  {
    name: "create session posts the requested title",
    input: { kind: "create" as const, title: "review", responseBody: { id: "session-new" } },
    assert: [
      returns<EmptyContext, EndpointResult>({
        value: "session-new",
        calls: [{ url: "http://127.0.0.1:4096/session", method: "POST", body: JSON.stringify({ title: "review" }) }],
      }),
    ],
  },
  {
    name: "update session title patches the session title",
    input: { kind: "title" as const, sessionId: "session-1", title: "review", responseBody: true },
    assert: [
      returns<EmptyContext, EndpointResult>({
        value: true,
        calls: [
          {
            url: "http://127.0.0.1:4096/session/session-1",
            method: "PATCH",
            body: JSON.stringify({ title: "review" }),
          },
        ],
      }),
    ],
  },
  {
    name: "reports a rejected session title update",
    input: {
      kind: "title" as const,
      sessionId: "session-1",
      title: "review",
      responseBody: { error: "unsupported" },
      responseStatus: 400,
    },
    assert: [
      returns<EmptyContext, EndpointResult>({
        value: false,
        calls: [
          {
            url: "http://127.0.0.1:4096/session/session-1",
            method: "PATCH",
            body: JSON.stringify({ title: "review" }),
          },
        ],
      }),
    ],
  },
  {
    name: "abort posts to the session abort endpoint",
    input: { kind: "abort" as const, sessionId: "session-1", responseBody: true },
    assert: [
      returns<EmptyContext, EndpointResult>({
        value: true,
        calls: [{ url: "http://127.0.0.1:4096/session/session-1/abort", method: "POST", body: undefined }],
      }),
    ],
  },
  {
    name: "permission reply posts response and remember",
    input: { kind: "permission" as const, sessionId: "session-1", permissionId: "permission-9", responseBody: true },
    assert: [
      returns<EmptyContext, EndpointResult>({
        value: true,
        calls: [
          {
            url: "http://127.0.0.1:4096/session/session-1/permissions/permission-9",
            method: "POST",
            body: JSON.stringify({ response: "allow", remember: true }),
          },
        ],
      }),
    ],
  },
  {
    name: "fork posts to the session fork endpoint",
    input: { kind: "fork" as const, sessionId: "session-1", responseBody: { id: "session-fork" } },
    assert: [
      returns<EmptyContext, EndpointResult>({
        value: "session-fork",
        calls: [{ url: "http://127.0.0.1:4096/session/session-1/fork", method: "POST", body: "{}" }],
      }),
    ],
  },
  {
    name: "session status is read from the status map",
    input: { kind: "status" as const, sessionId: "session-1", responseBody: { "session-1": { type: "busy" } } },
    assert: [
      returns<EmptyContext, EndpointResult>({
        value: "busy",
        calls: [{ url: "http://127.0.0.1:4096/session/status", method: "GET", body: undefined }],
      }),
    ],
  },
  {
    name: "routes a session request to the configured OpenCode directory",
    input: { kind: "directory" as const, responseBody: { id: "session-new" } },
    assert: [
      returns<EmptyContext, EndpointResult>({
        value: "session-new",
        calls: [{ url: "http://127.0.0.1:4096/session", method: "POST", body: "{}" }],
        directoryHeader: "/workspace",
      }),
    ],
  },
  {
    name: "bounds a hung short-lived request",
    input: { kind: "timeout" as const, requestTimeoutMs: 1 },
    assert: [hasObserved<EmptyContext, EndpointResult>("value", { error: "OpenCodeRequestTimeoutError" })],
  },
] satisfies readonly OperationCase<"default", EndpointInput, EndpointResult, EmptyContext>[];

const endpointTable: OperationTable<undefined, "default", EndpointInput, EndpointResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: endpointCases,
  execute: async (_fixture, input) => {
    const calls: CallRecord[] = [];
    const client = new OpenCodeClient("http://127.0.0.1:4096", {
      requestTimeoutMs: input.requestTimeoutMs,
      ...(input.kind === "directory" ? { directory: "/workspace" } : {}),
      request: async (url, init) => {
        calls.push({ url: String(url), init });
        if (input.kind === "timeout") return new Promise<Response>(() => {});
        return new Response(JSON.stringify(input.responseBody), {
          status: input.responseStatus ?? 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    let value: unknown;
    try {
      switch (input.kind) {
        case "health":
          value = await Effect.runPromise(client.health());
          break;
        case "create":
          value = await Effect.runPromise(client.createSession(input.title));
          break;
        case "abort":
          value = await Effect.runPromise(client.abortSession(input.sessionId!));
          break;
        case "permission":
          value = await Effect.runPromise(client.replyPermission(input.sessionId!, input.permissionId!, "allow", true));
          break;
        case "fork":
          value = await Effect.runPromise(client.forkSession(input.sessionId!));
          break;
        case "status":
          value = await Effect.runPromise(client.sessionStatus(input.sessionId!));
          break;
        case "title":
          value = await Effect.runPromise(client.setSessionTitle(input.sessionId!, input.title!));
          break;
        case "directory":
          value = await Effect.runPromise(client.createSession());
          break;
        case "timeout":
          await Effect.runPromise(client.createSession());
          value = { error: "request unexpectedly completed" };
          break;
      }
    } catch (error) {
      value = { error: error instanceof OpenCodeRequestTimeoutError ? error.name : String(error) };
    }
    return {
      value,
      calls: calls.map((call) => ({
        url: call.url,
        method: call.init?.method ?? "GET",
        body: typeof call.init?.body === "string" ? call.init.body : undefined,
      })),
      ...(input.kind === "directory"
        ? { directoryHeader: new Headers(calls[0]?.init?.headers).get("x-opencode-directory") }
        : {}),
    };
  },
  observe: (_fixture, result) => (result.ok ? result.value : { value: undefined, calls: [] }),
};

describe("opencode client", () => {
  runOperationTable(it as unknown as TestRegistrar, sseTable);
  runOperationTable(it as unknown as TestRegistrar, endpointTable);
});
