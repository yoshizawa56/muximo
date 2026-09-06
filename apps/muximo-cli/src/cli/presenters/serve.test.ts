import type { ServeRouteState, TailscaleServeResult } from "@muximo/infrastructure/cli-client";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import type { CliIo } from "../commands/types.js";
import type { ServeResult } from "../handlers/system.js";
import { presentServeResult } from "./serve.js";

type Fixture = {
  result: ServeResult;
  out: string[];
  err: string[];
};

type Context = {
  out: string;
  err: string;
};

type FixtureKey = "clean" | "injected";

const esc = String.fromCharCode(27);

const routeState: ServeRouteState = {
  schemaVersion: 1,
  component: "muximod",
  provider: "tailscale",
  hostname: "tail.example",
  publicUrl: "https://tail.example:8444/",
  localTarget: "http://127.0.0.1:4317",
  externalPort: 8444,
  path: "/",
  routeFingerprint: "fingerprint",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

function serveResult(stdout: string, stderr: string): ServeResult {
  const result: TailscaleServeResult = {
    options: { provider: "tailscale", localPort: 4317, externalPort: 8444, tailscaleBinary: "tailscale" },
    route: {
      localPort: 4317,
      externalPort: 8444,
      hostname: routeState.hostname,
      localTarget: routeState.localTarget,
      publicUrl: routeState.publicUrl,
      routeFingerprint: routeState.routeFingerprint,
    },
    serveArgs: ["serve", "--bg"],
    hostname: "tail.example",
    url: routeState.publicUrl,
    localUrl: routeState.localTarget,
    stdout,
    stderr,
    statusJson: "{}",
  };
  return { command: "tailscale", result, state: routeState };
}

const cases = [
  {
    name: "passes through clean provider output",
    fixture: "clean" as const,
    input: {},
    assert: [
      returns<Context, number>(0),
      hasObserved<Context, number>(
        "out",
        "[muximo-cli] muximod Tailscale Serve: https://tail.example:8444/ -> http://127.0.0.1:4317\nserve stdout\n",
      ),
      hasObserved<Context, number>("err", "serve stderr\n"),
    ],
  },
  {
    name: "strips ANSI escapes and control characters from provider output",
    fixture: "injected" as const,
    input: {},
    assert: [
      returns<Context, number>(0),
      hasObserved<Context, number>(
        "out",
        "[muximo-cli] muximod Tailscale Serve: https://tail.example:8444/ -> http://127.0.0.1:4317\nserveed\n",
      ),
      hasObserved<Context, number>("err", "noisy\n"),
      {
        name: "leaves no escape or control characters in either stream",
        check: (context: Context) => {
          expect(context.out).not.toContain(esc);
          expect(context.err).not.toContain(esc);
          expect(context.out).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/);
          expect(context.err).not.toMatch(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/);
        },
      },
    ],
  },
] satisfies readonly OperationCase<FixtureKey, {}, number, Context>[];

const table: OperationTable<Fixture, FixtureKey, {}, number, Context> = {
  defaultFixture: () => ({ fixture: createFixture("clean") }),
  fixtures: {
    clean: () => ({ fixture: createFixture("clean") }),
    injected: () => ({ fixture: createFixture("injected") }),
  },
  cases,
  execute: (fixture) => presentServeResult(fixture.result, createIo(fixture)),
  observe: (fixture) => ({ out: fixture.out.join(""), err: fixture.err.join("") }),
};

function createFixture(key: FixtureKey): Fixture {
  if (key === "clean") return { result: serveResult("serve stdout\n", "serve stderr\n"), out: [], err: [] };
  const osc = `${esc}]0;injected-title\x07`;
  const csi = `${esc}[31m`;
  const controls = `${String.fromCharCode(1)}${String.fromCharCode(7)}`;
  return {
    result: serveResult(`${csi}serve${esc}(B${osc}${controls}ed\n`, `no${esc}[2K${controls}isy\n`),
    out: [],
    err: [],
  };
}

function createIo(fixture: Fixture): CliIo {
  return {
    out: { write: (value: string) => fixture.out.push(value) },
    err: { write: (value: string) => fixture.err.push(value) },
  } as unknown as CliIo;
}

describe("serve presenter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
