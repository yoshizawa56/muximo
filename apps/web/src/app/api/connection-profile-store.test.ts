import {
  type Assertion,
  type FixtureHandle,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import {
  type BrowserConnectionProfile,
  clearBrowserConnectionProfile,
  connectionForProfile,
  normalizeMuximodBaseUrl,
  readBrowserConnectionProfile,
  saveBrowserConnectionProfile,
} from "./connection-profile-store";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }
  clear(): void {
    this.values.clear();
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

type EmptyContext = {};

const normalizeCases = [
  {
    name: "removes a trailing slash",
    input: "https://workstation.tailnet.ts.net/",
    assert: [returns<EmptyContext, string>("https://workstation.tailnet.ts.net")],
  },
  {
    name: "preserves a non-default port",
    input: "https://workstation.tailnet.ts.net:8449/",
    assert: [returns<EmptyContext, string>("https://workstation.tailnet.ts.net:8449")],
  },
  {
    name: "removes path and query details",
    input: "https://example.test/muximod/?ignored=1",
    assert: [returns<EmptyContext, string>("https://example.test/muximod")],
  },
] satisfies readonly OperationCase<"default", string, string, EmptyContext>[];

const normalizeTable: OperationTable<undefined, "default", string, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: normalizeCases,
  execute: (_fixture, input) => normalizeMuximodBaseUrl(input),
  observe: () => ({}),
};

const connectionCases = [
  {
    name: "does not create a transport without a saved profile",
    input: null,
    assert: [returns<EmptyContext, ReturnType<typeof connectionForProfile>>(undefined)],
  },
] satisfies readonly OperationCase<"default", null, ReturnType<typeof connectionForProfile>, EmptyContext>[];

const connectionTable: OperationTable<
  undefined,
  "default",
  null,
  ReturnType<typeof connectionForProfile>,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: connectionCases,
  execute: (_fixture, input) => connectionForProfile(input),
  observe: () => ({}),
};

type ProfileFixture = { storage: MemoryStorage };
type ProfileStep =
  | { type: "save"; input: Pick<BrowserConnectionProfile, "name" | "muximodBaseUrl"> }
  | { type: "set-raw"; value: string }
  | { type: "clear" }
  | { type: "read" };
type ProfileContext = { raw: string | null };
type ProfileResult = BrowserConnectionProfile | null;

const profileFixture = (): FixtureHandle<ProfileFixture> => ({
  fixture: { storage: new MemoryStorage() },
});

const hasProfileName = (expected: string): Assertion<ProfileContext, ProfileResult> => ({
  name: `returns profile ${expected}`,
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value?.name).toBe(expected);
  },
});

const hasProfileEndpoint = (expected: string): Assertion<ProfileContext, ProfileResult> => ({
  name: `returns endpoint ${expected}`,
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value?.muximodBaseUrl).toBe(expected);
  },
});

const hasNoCredentialFields = (): Assertion<ProfileContext, ProfileResult> => ({
  name: "persists no credential fields",
  check: (ctx) => {
    expect(ctx.raw).not.toContain("key");
    expect(ctx.raw).not.toContain("password");
  },
});

const profileCases = [
  {
    name: "round-trips a profile without credentials",
    steps: [
      { type: "save", input: { name: "Workstation", muximodBaseUrl: "https://workstation.tailnet.ts.net/" } },
      { type: "read" },
    ],
    assert: [hasProfileName("Workstation"), hasNoCredentialFields()],
  },
  {
    name: "ignores malformed stored data",
    steps: [{ type: "set-raw", value: "not-json" }, { type: "read" }],
    assert: [returns<ProfileContext, ProfileResult>(null)],
  },
  {
    name: "reads the legacy serveUrl field as a muximod endpoint",
    steps: [
      {
        type: "set-raw",
        value: JSON.stringify({
          id: "default",
          name: "Workstation",
          serveUrl: "https://workstation.tailnet.ts.net/",
          updatedAt: "2026-08-15T00:00:00.000Z",
        }),
      },
      { type: "read" },
    ],
    assert: [hasProfileEndpoint("https://workstation.tailnet.ts.net")],
  },
  {
    name: "clears a saved profile",
    steps: [
      { type: "save", input: { name: "Workstation", muximodBaseUrl: "https://workstation.tailnet.ts.net" } },
      { type: "clear" },
      { type: "read" },
    ],
    assert: [returns<ProfileContext, ProfileResult>(null)],
  },
] satisfies readonly ScenarioCase<"default", ProfileStep, ProfileResult, ProfileContext>[];

const profileTable: ScenarioTable<ProfileFixture, "default", ProfileStep, ProfileResult, ProfileContext> = {
  defaultFixture: profileFixture,
  cases: profileCases,
  execute: (fixture, steps) => {
    let result: ProfileResult = null;
    for (const step of steps) {
      if (step.type === "save") result = saveBrowserConnectionProfile(step.input, fixture.storage);
      if (step.type === "set-raw") fixture.storage.setItem("muximo.connection-profile.v1", step.value);
      if (step.type === "clear") clearBrowserConnectionProfile(fixture.storage);
      if (step.type === "read") result = readBrowserConnectionProfile(fixture.storage);
    }
    return result;
  },
  observe: (fixture) => ({ raw: fixture.storage.getItem("muximo.connection-profile.v1") }),
};

describe("browser connection profile", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, normalizeTable);
  runOperationTable(register, connectionTable);
  runScenarioTable(register, profileTable);
});
