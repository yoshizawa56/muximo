import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { describe, it } from "vitest";
import {
  readServeRouteState,
  removeServeRouteState,
  type ServeRouteState,
  writeServeRouteState,
} from "./route-state.js";

type RouteOperation =
  | { kind: "read" }
  | { kind: "write" }
  | { kind: "write-default" }
  | { kind: "invalid-json" }
  | { kind: "invalid-shape" }
  | { kind: "remove" };

type RouteFixture = {
  stateFile: string;
  state: ServeRouteState;
  defaultState: ServeRouteState;
};

type RouteContext = {
  state: ServeRouteState | null;
  fileExists: boolean;
  fileMode: number | null;
};

const state: ServeRouteState = {
  schemaVersion: 2,
  environment: "local",
  component: "web",
  provider: "tailscale",
  hostname: "machine.tailnet.ts.net",
  publicUrl: "https://machine.tailnet.ts.net:8449/",
  localTarget: "http://127.0.0.1:5227",
  externalPort: 8449,
  path: "/",
  routeFingerprint: "route-fingerprint",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

const cases = [
  {
    name: "returns undefined when component route state is absent",
    input: { kind: "read" },
    assert: [hasObserved<RouteContext, ServeRouteState | undefined>("state", null), hasObserved("fileExists", false)],
  },
  {
    name: "writes a private atomic route state and reads it back exactly",
    input: { kind: "write" },
    assert: [
      hasObserved<RouteContext, ServeRouteState | undefined>("state", state),
      hasObserved("fileExists", true),
      hasObserved("fileMode", 0o600),
    ],
  },
  {
    name: "writes a default-profile route state without an environment name",
    input: { kind: "write-default" },
    assert: [
      hasObserved<RouteContext, ServeRouteState | undefined>("state", {
        schemaVersion: 2,
        component: "web",
        provider: "tailscale",
        hostname: "machine.tailnet.ts.net",
        publicUrl: "https://machine.tailnet.ts.net:8449/",
        localTarget: "http://127.0.0.1:5227",
        externalPort: 8449,
        path: "/",
        routeFingerprint: "route-fingerprint",
        updatedAt: "2026-08-29T00:00:00.000Z",
      }),
      hasObserved("fileExists", true),
      hasObserved("fileMode", 0o600),
    ],
  },
  {
    name: "rejects invalid JSON instead of treating it as an absent route",
    input: { kind: "invalid-json" },
    assert: [hasError<RouteContext, ServeRouteState | undefined>({ message: /contains invalid JSON/ })],
  },
  {
    name: "rejects an invalid route shape",
    input: { kind: "invalid-shape" },
    assert: [hasError<RouteContext, ServeRouteState | undefined>({ message: /invalid format/ })],
  },
  {
    name: "removes only the component route state file",
    input: { kind: "remove" },
    assert: [hasObserved<RouteContext, ServeRouteState | undefined>("state", null), hasObserved("fileExists", false)],
  },
] satisfies readonly OperationCase<"default", RouteOperation, ServeRouteState | undefined, RouteContext>[];

const table: OperationTable<RouteFixture, "default", RouteOperation, ServeRouteState | undefined, RouteContext> = {
  defaultFixture: () => createFixture(),
  cases,
  execute: (fixture, input) => {
    if (input.kind === "write") writeServeRouteState(fixture.stateFile, fixture.state);
    if (input.kind === "write-default") writeServeRouteState(fixture.stateFile, fixture.defaultState);
    if (input.kind === "invalid-json") writeFileSync(fixture.stateFile, "not json\n");
    if (input.kind === "invalid-shape") {
      writeFileSync(fixture.stateFile, JSON.stringify({ ...fixture.state, path: "relative" }));
    }
    if (input.kind === "remove") {
      writeServeRouteState(fixture.stateFile, fixture.state);
      removeServeRouteState(fixture.stateFile);
    }
    return readServeRouteState(fixture.stateFile);
  },
  observe: (fixture, result) => ({
    state: result.ok ? (result.value ?? null) : null,
    fileExists: existsSync(fixture.stateFile),
    fileMode: readPrivateMode(fixture.stateFile),
  }),
};

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "muximo-route-state-test-"));
  mkdirSync(join(root, "nested"));
  const defaultState: ServeRouteState = { ...state };
  delete defaultState.environment;
  return {
    fixture: { stateFile: join(root, "nested", "serve.json"), state, defaultState },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function readPrivateMode(path: string): number | null {
  try {
    readFileSync(path);
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

describe("Tailscale Serve route state", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
