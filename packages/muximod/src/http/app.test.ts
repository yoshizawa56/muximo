import type { MuximodApplication } from "@muximo/application";
import type { MuximodSocket } from "@muximo/infrastructure/runtime";
import {
  type Assertion,
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import type { MuximodApp } from "./app.js";
import { createMuximodApp } from "./app.js";
import { createOriginPolicy } from "./middleware.js";
import { TestMuximodSocketAdapter } from "./test-socket.js";
import type { MuximodAuthPort } from "./types.js";
import { maxWebProxyRequestBodyBytes } from "./web-proxy.js";
import { maxPendingWebProxyBytes } from "./ws-terminal.js";

const authContext = {
  sessionId: "session-http-test-00000000",
  serverId: "server-http-test-00000000",
  deviceId: "device-http-test-00000000",
  issuedAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2099-08-15T00:00:00.000Z",
  device: {
    deviceId: "device-http-test-00000000",
    serverId: "server-http-test-00000000",
    publicKey: { kty: "EC" as const, crv: "P-256" as const, x: "x", y: "y" },
    keyFingerprint: "fingerprint-http-test",
    displayName: "HTTP test",
    deviceType: "browser" as const,
    status: "active" as const,
    createdAt: "2026-08-15T00:00:00.000Z",
    approvedAt: "2026-08-15T00:00:00.000Z",
  },
};
const serveOrigin = "https://machine.tailnet.ts.net:8444";

type SocketInput =
  | { kind: "plain" }
  | { kind: "proxy" }
  | { kind: "proxy-denied" }
  | { kind: "proxy-runtime" }
  | { kind: "proxy-websocket"; protocol: string }
  | { kind: "proxy-websocket-overflow" }
  | { kind: "proxy-websocket-close-code" }
  | { kind: "proxy-oversize-post" }
  | { kind: "websocket"; ticket: string; payload?: readonly number[] };

type SocketResult =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "websocket"; opened: boolean; received: number[]; protocol?: string; closeCode?: number };

type SocketFixture = {
  app: MuximodApp;
  server: ReturnType<typeof Bun.serve>;
  consumedTickets: string[];
  terminalConnections: number;
  socketFactoryCalls: number;
  upstreamRequests: number;
  upstreamProtocols: string[];
  webProxy: { enabled: true; host: string; port: number };
  hangingPort: number;
  stopHanging: () => void;
};

type SocketContext = {
  consumedTickets: readonly string[];
  terminalConnections: number;
  socketFactoryCalls: number;
  upstreamRequests: number;
  upstreamProtocols: readonly string[];
  idleTimeout: number;
};

const responseIs = (status: number, body: unknown): Assertion<SocketContext, SocketResult> => ({
  name: `returns HTTP ${status}`,
  check: (_ctx, result) => {
    expect(result).toEqual({ ok: true, value: { kind: "response", status, body } });
  },
});

const websocketIs = (
  expected: Partial<Extract<SocketResult, { kind: "websocket" }>>,
): Assertion<SocketContext, SocketResult> => ({
  name: "returns the expected WebSocket observation",
  check: (_ctx, result) => {
    expect(result).toMatchObject({ ok: true, value: { kind: "websocket", ...expected } });
  },
});

const fixture = async (): Promise<FixtureHandle<SocketFixture>> => {
  const consumedTickets: string[] = [];
  const validTickets = new Set(["ticket-terminal"]);
  let terminalConnections = 0;
  let socketFactoryCalls = 0;
  let upstreamRequests = 0;
  const upstreamProtocols: string[] = [];
  const auth: MuximodAuthPort = {
    serverId: authContext.serverId,
    authenticateAccessToken: async () => authContext,
    claimPairing: async () => {
      throw new Error("not used");
    },
    pairingStatus: async () => {
      throw new Error("not used");
    },
    createChallenge: async () => {
      throw new Error("not used");
    },
    createSession: async () => {
      throw new Error("not used");
    },
    issueWebSocketTicket: async () => {
      throw new Error("not used");
    },
    consumeWebSocketTicket: async (ticket, endpoint) => {
      const expected = `ticket-${endpoint}`;
      if (!ticket || ticket !== expected || !validTickets.has(ticket)) return undefined;
      consumedTickets.push(`${endpoint}:${ticket}`);
      validTickets.delete(ticket);
      return authContext;
    },
  };
  const application: MuximodApplication = {
    agentSessions: {
      prepareRun: async () => {
        throw new Error("not used");
      },
      prepareResume: async () => {
        throw new Error("not used");
      },
      attach: async () => {
        throw new Error("not used");
      },
      completeRun: async () => {
        throw new Error("not used");
      },
      completeResume: async () => {
        throw new Error("not used");
      },
      cleanup: async () => {
        throw new Error("not used");
      },
      list: async () => ({ allViews: [], views: [] }),
    },
    terminal: {
      get: async () => ({
        id: "terminal",
        name: "terminal",
        host: "host",
        tailnetIp: "100.64.0.1",
        state: "online",
        detail: "test",
        lastSeen: "now",
      }),
    },
    workspaces: {
      list: async () => [],
      browse: async () => [],
      register: async () => {
        throw new Error("not used");
      },
      update: async () => {
        throw new Error("not used");
      },
      delete: async () => {
        throw new Error("not used");
      },
    },
    sessions: {
      list: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      manage: async () => ({ name: "unused", changed: false }),
    },
    panes: {
      list: async () => [],
      create: async () => {
        throw new Error("not used");
      },
    },
    hooks: { handleTerminalHostHook: async () => undefined },
  };
  const echo = (socket: MuximodSocket): void => {
    socket.onMessage((data, isBinary) => {
      if (isBinary) socket.send(data);
    });
  };
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request, server) => {
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const protocol = request.headers.get("sec-websocket-protocol");
        if (protocol !== null) {
          upstreamProtocols.push(protocol);
          server.upgrade(request, { headers: { "Sec-WebSocket-Protocol": protocol } });
        } else {
          server.upgrade(request);
        }
        return undefined;
      }
      upstreamRequests += 1;
      return new Response("proxied Web");
    },
    websocket: {
      message: (socket, message) => {
        if (isCloseTrigger(message)) {
          socket.close(4404, "upstream bye");
          return;
        }
        socket.send(message);
      },
    },
  });
  if (upstream.port === undefined) throw new Error("Web proxy test server did not expose a port");
  const hangingListener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open() {},
      data() {},
      close() {},
      error() {},
    },
  });
  const webProxy = { enabled: true as const, host: "127.0.0.1", port: upstream.port };
  const originPolicy = createOriginPolicy({ allowedOrigins: ["http://client.test"], allowNoOrigin: true });
  originPolicy.setRuntimeOrigin(serveOrigin);
  const app = createMuximodApp({
    auth,
    application,
    originPolicy,
    hookToken: "hook",
    socketFactory: (transport) => {
      socketFactoryCalls += 1;
      return new TestMuximodSocketAdapter(transport);
    },
    onTerminalConnection: (socket) => {
      terminalConnections += 1;
      echo(socket);
    },
    webProxy,
  });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
    websocket: app.websocket,
  });
  return {
    fixture: {
      app,
      server,
      consumedTickets,
      get terminalConnections() {
        return terminalConnections;
      },
      get socketFactoryCalls() {
        return socketFactoryCalls;
      },
      get upstreamRequests() {
        return upstreamRequests;
      },
      upstreamProtocols,
      webProxy,
      hangingPort: hangingListener.port,
      stopHanging: () => hangingListener.stop(true),
    },
    cleanup: () => {
      server.stop(true);
      upstream.stop(true);
      hangingListener.stop(true);
    },
  };
};

const cases = [
  {
    name: "rejects an ordinary HTTP request before attempting an upgrade",
    input: { kind: "plain" },
    assert: [
      responseIs(426, { error: "upgrade_required", message: "WebSocket upgrade is required" }),
      hasObserved<SocketContext, SocketResult>("consumedTickets", []),
      hasObserved<SocketContext, SocketResult>("idleTimeout", 0),
    ],
  },
  {
    name: "proxies the unreserved Web path to the Vite target",
    input: { kind: "proxy" },
    assert: [responseIs(200, "proxied Web"), hasObserved<SocketContext, SocketResult>("upstreamRequests", 1)],
  },
  {
    name: "rejects a cross-origin Web proxy request before reaching Vite",
    input: { kind: "proxy-denied" },
    assert: [
      responseIs(403, { error: "origin_not_allowed", message: "Request origin is not allowed" }),
      hasObserved<SocketContext, SocketResult>("upstreamRequests", 0),
    ],
  },
  {
    name: "proxies a request from the registered Serve origin",
    input: { kind: "proxy-runtime" },
    assert: [responseIs(200, "proxied Web"), hasObserved<SocketContext, SocketResult>("upstreamRequests", 1)],
  },
  {
    name: "bridges the WebSocket upgrade used by Vite HMR",
    input: { kind: "proxy-websocket", protocol: "vite-hmr" },
    assert: [
      websocketIs({ opened: true, received: [0, 1, 255], protocol: "vite-hmr" }),
      hasObserved<SocketContext, SocketResult>("upstreamProtocols", ["vite-hmr"]),
    ],
  },
  {
    name: "closes a Web proxy whose upstream buffer exceeds the limit",
    input: { kind: "proxy-websocket-overflow" },
    assert: [websocketIs({ opened: true, closeCode: 1009 })],
  },
  {
    name: "propagates the upstream close code to the proxied client",
    input: { kind: "proxy-websocket-close-code" },
    assert: [websocketIs({ opened: true, received: [], closeCode: 4404 })],
  },
  {
    name: "rejects a Web proxy post whose body exceeds the limit",
    input: { kind: "proxy-oversize-post" },
    assert: [
      responseIs(413, "Web proxy request body is too large"),
      hasObserved<SocketContext, SocketResult>("upstreamRequests", 0),
    ],
  },
  {
    name: "rejects an invalid ticket without opening an application connection",
    input: { kind: "websocket", ticket: "invalid-ticket" },
    assert: [
      websocketIs({ opened: false, received: [] }),
      hasObserved<SocketContext, SocketResult>("consumedTickets", []),
      hasObserved<SocketContext, SocketResult>("terminalConnections", 0),
    ],
  },
  {
    name: "forwards binary terminal data through the injected socket adapter",
    input: { kind: "websocket", ticket: "ticket-terminal", payload: [0, 1, 255] },
    assert: [
      websocketIs({ opened: true, received: [0, 1, 255] }),
      hasObserved<SocketContext, SocketResult>("consumedTickets", ["terminal:ticket-terminal"]),
      hasObserved<SocketContext, SocketResult>("terminalConnections", 1),
      hasObserved<SocketContext, SocketResult>("socketFactoryCalls", 1),
    ],
  },
] satisfies readonly OperationCase<"default", SocketInput, SocketResult, SocketContext>[];

const table: OperationTable<SocketFixture, "default", SocketInput, SocketResult, SocketContext> = {
  defaultFixture: fixture,
  cases,
  execute: async (world, input) => {
    const url = `http://127.0.0.1:${world.server.port}/terminal`;
    if (input.kind === "proxy") {
      const response = await fetch(`http://127.0.0.1:${world.server.port}/`);
      return { kind: "response", status: response.status, body: await response.text() };
    }
    if (input.kind === "proxy-denied") {
      const response = await fetch(`http://127.0.0.1:${world.server.port}/`, {
        headers: { origin: "http://evil.example" },
      });
      return { kind: "response", status: response.status, body: await response.json() };
    }
    if (input.kind === "proxy-runtime") {
      const response = await fetch(`http://127.0.0.1:${world.server.port}/`, {
        headers: { origin: serveOrigin },
      });
      return { kind: "response", status: response.status, body: await response.text() };
    }
    if (input.kind === "proxy-websocket") {
      return {
        kind: "websocket",
        ...(await openWebSocket(`ws://127.0.0.1:${world.server.port}/hmr`, [0, 1, 255], [input.protocol])),
      };
    }
    if (input.kind === "proxy-websocket-overflow") {
      world.webProxy.port = world.hangingPort;
      return {
        kind: "websocket",
        ...(await openWebSocket(
          `ws://127.0.0.1:${world.server.port}/hmr`,
          new Array<number>(maxPendingWebProxyBytes + 1).fill(0),
        )),
      };
    }
    if (input.kind === "proxy-websocket-close-code") {
      return {
        kind: "websocket",
        ...(await openWebSocket(`ws://127.0.0.1:${world.server.port}/hmr`, [7, 7, 7])),
      };
    }
    if (input.kind === "proxy-oversize-post") {
      const response = await fetch(`http://127.0.0.1:${world.server.port}/upload`, {
        method: "POST",
        body: new Uint8Array(maxWebProxyRequestBodyBytes + 1),
      });
      return { kind: "response", status: response.status, body: await response.text() };
    }
    if (input.kind === "plain") {
      const response = await fetch(url);
      return { kind: "response", status: response.status, body: await response.json() };
    }
    const ticket = encodeURIComponent(input.ticket);
    return { kind: "websocket", ...(await openWebSocket(`${url}?ticket=${ticket}`, input.payload)) };
  },
  observe: (world) => ({
    consumedTickets: [...world.consumedTickets],
    terminalConnections: world.terminalConnections,
    socketFactoryCalls: world.socketFactoryCalls,
    upstreamRequests: world.upstreamRequests,
    upstreamProtocols: [...world.upstreamProtocols],
    idleTimeout: world.app.websocket.idleTimeout,
  }),
};

describe("muximod Bun WebSocket boundary", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function isCloseTrigger(message: string | Buffer | ArrayBuffer): boolean {
  const bytes =
    typeof message === "string"
      ? Buffer.from(message, "utf8")
      : message instanceof ArrayBuffer
        ? Buffer.from(message)
        : message;
  return bytes.length === 3 && bytes[0] === 7 && bytes[1] === 7 && bytes[2] === 7;
}

function openWebSocket(
  url: string,
  payload?: readonly number[],
  protocols: readonly string[] = [],
): Promise<{ opened: boolean; received: number[]; protocol?: string; closeCode?: number }> {
  return new Promise((resolve, reject) => {
    const socket = protocols.length === 0 ? new WebSocket(url) : new WebSocket(url, [...protocols]);
    socket.binaryType = "arraybuffer";
    let opened = false;
    let received: number[] = [];
    let closeCode: number | undefined;
    let settled = false;
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket test timed out: ${url}`));
    }, 2_000);
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ opened, received, protocol: socket.protocol || undefined, closeCode });
    };
    socket.onopen = () => {
      opened = true;
      if (payload) {
        socket.send(new Uint8Array(payload));
      } else {
        socket.close(1000, "test complete");
      }
    };
    socket.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) received = [...new Uint8Array(event.data)];
      else if (event.data instanceof Blob) received = [...new Uint8Array(await event.data.arrayBuffer())];
      socket.close(1000, "test complete");
    };
    socket.onerror = () => {
      if (!opened) finish();
    };
    socket.onclose = (event) => {
      closeCode = event.code;
      finish();
    };
  });
}
