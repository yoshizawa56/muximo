import { describe, expect, it } from "vitest";
import type { MuximodApplication, MuximodSocket } from "@muximo/application";
import {
  runOperationTable,
  hasObserved,
  type Assertion,
  type FixtureHandle,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import type { MuximodApp } from "./app.js";
import { createMuximodApp } from "./app.js";
import type { MuximodAuthPort } from "./types.js";

const authContext = {
  sessionId: "session-http-test-00000000",
  serverId: "server-http-test-00000000",
  deviceId: "device-http-test-00000000",
  issuedAt: "2026-08-15T00:00:00.000Z",
  expiresAt: "2099-08-15T00:00:00.000Z",
  revokedAt: null,
  device: {
    deviceId: "device-http-test-00000000",
    serverId: "server-http-test-00000000",
    publicKeyJwk: "{}",
    keyFingerprint: "fingerprint-http-test",
    displayName: "HTTP test",
    deviceType: "browser" as const,
    platform: null,
    clientVersion: null,
    status: "active" as const,
    createdAt: "2026-08-15T00:00:00.000Z",
    approvedAt: "2026-08-15T00:00:00.000Z",
    lastSeenAt: null,
    revokedAt: null,
  },
};

type SocketInput =
  | { kind: "plain" }
  | { kind: "websocket"; ticket: string; payload?: readonly number[] };

type SocketResult =
  | { kind: "response"; status: number; body: unknown }
  | { kind: "websocket"; opened: boolean; received: number[] };

type SocketFixture = {
  app: MuximodApp;
  server: ReturnType<typeof Bun.serve>;
  consumedTickets: string[];
  terminalConnections: number;
};

type SocketContext = {
  consumedTickets: readonly string[];
  terminalConnections: number;
  idleTimeout: number;
};

const responseIs = (status: number, body: unknown): Assertion<SocketContext, SocketResult> => ({
  name: `returns HTTP ${status}`,
  check: (_ctx, result) => {
    expect(result).toEqual({ ok: true, value: { kind: "response", status, body } });
  },
});

const websocketIs = (expected: { opened: boolean; received: number[] }): Assertion<SocketContext, SocketResult> => ({
  name: "returns the expected WebSocket observation",
  check: (_ctx, result) => {
    expect(result).toEqual({ ok: true, value: { kind: "websocket", ...expected } });
  },
});

const fixture = (): FixtureHandle<SocketFixture> => {
  const consumedTickets: string[] = [];
  const validTickets = new Set(["ticket-terminal"]);
  let terminalConnections = 0;
  const auth: MuximodAuthPort = {
    serverId: authContext.serverId,
    authenticateAccessToken: () => authContext,
    claimPairing: () => { throw new Error("not used"); },
    pairingStatus: () => { throw new Error("not used"); },
    createChallenge: () => { throw new Error("not used"); },
    createSession: () => { throw new Error("not used"); },
    issueWebSocketTicket: () => { throw new Error("not used"); },
    consumeWebSocketTicket: (ticket, endpoint) => {
      const expected = `ticket-${endpoint}`;
      if (!ticket || ticket !== expected || !validTickets.has(ticket)) return null;
      consumedTickets.push(`${endpoint}:${ticket}`);
      validTickets.delete(ticket);
      return authContext;
    },
  };
  const application: MuximodApplication = {
    terminal: { get: async () => ({ id: "terminal", name: "terminal", host: "host", tailnetIp: "100.64.0.1", state: "online", detail: "test", lastSeen: "now" }) },
    workspaces: {
      list: async () => [],
      browse: async () => [],
      register: async () => { throw new Error("not used"); },
      update: async () => { throw new Error("not used"); },
      delete: async () => { throw new Error("not used"); },
      resolveDirectory: async () => { throw new Error("not used"); },
      resolveSelection: async () => { throw new Error("not used"); },
    },
    sessions: { list: async () => [], create: async () => { throw new Error("not used"); } },
    panes: { list: async () => [], create: async () => { throw new Error("not used"); } },
    hooks: { handleTmux: () => undefined },
  };
  const echo = (socket: MuximodSocket): void => {
    socket.onMessage((data, isBinary) => {
      if (isBinary) socket.send(data);
    });
  };
  const app = createMuximodApp({
    auth,
    application,
    corsOrigin: "http://client.test",
    hookToken: "hook",
    onTerminalConnection: (socket) => {
      terminalConnections += 1;
      echo(socket);
    },
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
      get terminalConnections() { return terminalConnections; },
    },
    cleanup: () => server.stop(true),
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
    name: "rejects an invalid ticket without opening an application connection",
    input: { kind: "websocket", ticket: "invalid-ticket" },
    assert: [
      websocketIs({ opened: false, received: [] }),
      hasObserved<SocketContext, SocketResult>("consumedTickets", []),
      hasObserved<SocketContext, SocketResult>("terminalConnections", 0),
    ],
  },
  {
    name: "forwards binary terminal data through the Bun adapter",
    input: { kind: "websocket", ticket: "ticket-terminal", payload: [0, 1, 255] },
    assert: [
      websocketIs({ opened: true, received: [0, 1, 255] }),
      hasObserved<SocketContext, SocketResult>("consumedTickets", ["terminal:ticket-terminal"]),
      hasObserved<SocketContext, SocketResult>("terminalConnections", 1),
    ],
  },
] satisfies readonly OperationCase<"default", SocketInput, SocketResult, SocketContext>[];

const table: OperationTable<SocketFixture, "default", SocketInput, SocketResult, SocketContext> = {
  defaultFixture: fixture,
  cases,
  execute: async (world, input) => {
    const url = `http://127.0.0.1:${world.server.port}/terminal`;
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
    idleTimeout: world.app.websocket.idleTimeout,
  }),
};

describe("muximod Bun WebSocket boundary", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function openWebSocket(url: string, payload?: readonly number[]): Promise<{ opened: boolean; received: number[] }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    let opened = false;
    let received: number[] = [];
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`WebSocket test timed out: ${url}`));
    }, 2_000);
    const finish = (): void => {
      clearTimeout(timeout);
      resolve({ opened, received });
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
    socket.onclose = finish;
  });
}
