import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuximodWebSettings } from "@muximo/contract/control";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { createWebProcessManager, type WebProcessManager, type WebProcessStatus } from "./web-process.js";

type WebOperation = "lifecycle";
type WebFixture = {
  manager: WebProcessManager;
  settings: MuximodWebSettings["proxy"];
  root: string;
};
type WebContext = {
  states: readonly WebProcessStatus["state"][];
  pids: readonly (number | undefined)[];
};

const cases = [
  {
    name: "starts reuses moves and disables the configured Web process",
    input: "lifecycle" as const,
    assert: [
      hasObserved<WebContext, WebProcessStatus[]>("states", ["running", "running", "running", "disabled"]),
      hasObserved<WebContext, WebProcessStatus[]>("pids", [
        expect.any(Number),
        expect.any(Number),
        expect.any(Number),
        undefined,
      ]),
    ],
  },
] satisfies readonly OperationCase<"default", WebOperation, WebProcessStatus[], WebContext>[];

const table: OperationTable<WebFixture, "default", WebOperation, WebProcessStatus[], WebContext> = {
  defaultFixture: async () => createFixture(),
  cases,
  execute: async (fixture) => {
    const started = await fixture.manager.ensure();
    const reused = await fixture.manager.ensure();
    fixture.settings.port = await findFreePort();
    const moved = await fixture.manager.start();
    fixture.settings.enabled = false;
    const disabled = await fixture.manager.ensure();
    return [started, reused, moved, disabled];
  },
  observe: (_fixture, result) => ({
    states: result.ok ? result.value.map(({ state }) => state) : [],
    pids: result.ok ? result.value.map(({ pid }) => pid) : [],
  }),
};

describe("CLI Web process adapter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

async function createFixture(): Promise<FixtureHandle<WebFixture>> {
  const root = mkdtempSync(join(tmpdir(), "muximo-cli-web-process-test-"));
  const script = join(root, "web-server.mjs");
  writeFileSync(
    script,
    [
      'import { createServer } from "node:http";',
      'const portIndex = process.argv.indexOf("--port");',
      "const port = Number(process.argv[portIndex + 1]);",
      'const server = createServer((_request, response) => response.end("web"));',
      'server.listen(port, "127.0.0.1");',
      "const stop = () => server.close(() => process.exit(0));",
      'process.once("SIGINT", stop);',
      'process.once("SIGTERM", stop);',
    ].join("\n"),
    { mode: 0o600 },
  );
  const settings: MuximodWebSettings["proxy"] = { enabled: true, host: "127.0.0.1", port: await findFreePort() };
  const manager = createWebProcessManager({
    pidFile: join(root, "instance", "web.pid"),
    logFile: join(root, "instance", "web.log"),
    lockDirectory: join(root, "instance", "web.start.lock"),
    webRoot: root,
    command: process.execPath,
    viteEntrypoint: script,
    environment: process.env,
    resolveSettings: async () => settings,
  });
  return {
    fixture: { manager, settings, root },
    cleanup: async () => {
      await manager.stop().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function findFreePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("occupied") });
  if (server.port === undefined) {
    server.stop(true);
    throw new Error("test server did not expose a port");
  }
  const port = server.port;
  server.stop(true);
  return port;
}
