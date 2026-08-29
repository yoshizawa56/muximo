import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { createWebDaemonManager, type WebDaemonManager, type WebDaemonStatus } from "./web-daemon.js";

type WebInput = {
  operation: "lifecycle" | "occupied";
};

type WebFixture = {
  manager: WebDaemonManager;
  port: number;
  root: string;
  occupied?: Server;
};

type WebContext = {
  states: WebDaemonStatus["state"][];
  pids: Array<number | undefined>;
};

const cases = [
  {
    name: "starts reuses and stops one Web process",
    input: { operation: "lifecycle" },
    assert: [
      hasObserved<WebContext, WebDaemonStatus[]>("states", ["running", "running", "stopped"]),
      {
        name: "reuses the recorded process",
        check: (context: WebContext) => {
          expect(context.pids[0]).toBeDefined();
          expect(context.pids[0]).toBe(context.pids[1]);
        },
      },
    ],
  },
  {
    name: "rejects an unmanaged process on the fixed port",
    input: { operation: "occupied" },
    assert: [
      hasError<WebContext, WebDaemonStatus[]>({ message: /already in use by an unmanaged process/ }),
      hasObserved<WebContext, WebDaemonStatus[]>("states", []),
    ],
  },
] satisfies readonly OperationCase<"default", WebInput, WebDaemonStatus[], WebContext>[];

const table: OperationTable<WebFixture, "default", WebInput, WebDaemonStatus[], WebContext> = {
  defaultFixture: async () => {
    const root = mkdtempSync(join(tmpdir(), "muximo-web-daemon-test-"));
    const port = await findFreePort();
    const script = join(root, "web-server.mjs");
    writeFileSync(
      script,
      [
        'import { createServer } from "node:http";',
        "const port = Number(process.env.MUXIMO_TEST_WEB_PORT);",
        'const server = createServer((_request, response) => response.end("web"));',
        'server.listen(port, "127.0.0.1");',
        "const stop = () => server.close(() => process.exit(0));",
        'process.once("SIGINT", stop);',
        'process.once("SIGTERM", stop);',
      ].join("\n"),
      { mode: 0o600 },
    );
    const manager = createWebDaemonManager({
      instanceDirectory: join(root, "state"),
      host: "127.0.0.1",
      port,
      cwd: root,
      command: process.execPath,
      args: [script],
      environment: { ...process.env, MUXIMO_TEST_WEB_PORT: String(port) },
    });
    const fixture: WebFixture = { manager, port, root };
    return {
      fixture,
      cleanup: async () => {
        await manager.stop().catch(() => undefined);
        await closeServer(fixture.occupied);
        rmSync(root, { recursive: true, force: true });
      },
    };
  },
  cases,
  execute: async (fixture, input) => {
    if (input.operation === "occupied") {
      fixture.occupied = await listenServer(fixture.port);
      await fixture.manager.start();
      return [];
    }
    const started = await fixture.manager.start();
    const reused = await fixture.manager.start();
    const stopped = await fixture.manager.stop();
    return [started, reused, stopped];
  },
  observe: (_fixture, result) => ({
    states: result.ok ? result.value.map(({ state }) => state) : [],
    pids: result.ok ? result.value.map(({ pid }) => pid) : [],
  }),
};

describe("Web daemon lifecycle", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

async function findFreePort(): Promise<number> {
  const server = await listenServer(0);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("test server did not expose a TCP address");
  }
  const port = address.port;
  await closeServer(server);
  return port;
}

function listenServer(port: number): Promise<Server> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer((_request, response) => response.end("occupied"));
    server.once("error", rejectPromise);
    server.listen(port, "127.0.0.1", () => resolvePromise(server));
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolvePromise, rejectPromise) => {
    server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
  });
}
