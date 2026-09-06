import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MuximodWebSettings } from "@muximo/contract/control";
import {
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { createWebProcessManager, type WebProcessManager, type WebProcessStatus } from "./web-process.js";

type WebStep = { type: "ensure" } | { type: "move" } | { type: "disable" };
type WebFixture = {
  manager: WebProcessManager;
  settings: MuximodWebSettings["proxy"];
  root: string;
  alternatePort: number;
};
type WebContext = {
  states: readonly WebProcessStatus["state"][];
  pids: readonly (number | undefined)[];
};

const cases = [
  {
    name: "starts reuses moves and disables the configured Web process",
    steps: [{ type: "ensure" }, { type: "ensure" }, { type: "move" }, { type: "disable" }],
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
] satisfies readonly ScenarioCase<"default", WebStep, WebProcessStatus[], WebContext>[];

const table: ScenarioTable<WebFixture, "default", WebStep, WebProcessStatus[], WebContext> = {
  defaultFixture: async () => createFixture(),
  cases,
  execute: async (fixture, steps) => {
    const statuses: WebProcessStatus[] = [];
    for (const step of steps) {
      if (step.type === "ensure") statuses.push(await fixture.manager.ensure());
      else if (step.type === "move") {
        fixture.settings.port = fixture.alternatePort;
        statuses.push(await fixture.manager.start());
      } else {
        fixture.settings.enabled = false;
        statuses.push(await fixture.manager.ensure());
      }
    }
    return statuses;
  },
  observe: (_fixture, result) => ({
    states: result.ok ? result.value.map(({ state }) => state) : [],
    pids: result.ok ? result.value.map(({ pid }) => pid) : [],
  }),
};

describe("CLI Web process adapter", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
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
  const alternatePort = await findFreePort();
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
    fixture: { manager, settings, root, alternatePort },
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
