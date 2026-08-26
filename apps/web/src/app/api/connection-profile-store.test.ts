import {
  type Assertion,
  type FixtureHandle,
  hasError,
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
  connectionForProfile,
  defaultConnectionProfileName,
  normalizeMuximodBaseUrl,
  readBrowserConnectionProfiles,
  removeBrowserConnectionProfile,
  renameBrowserConnectionProfile,
  saveBrowserConnectionProfile,
  selectBrowserConnectionProfile,
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
    name: "removes credentials while preserving the endpoint path",
    input: "https://user:password@example.test/muximod/?ignored=1",
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
    name: "does not create a transport without a selected profile",
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

type SharedConnectionInput = { muximodBaseUrl: string };
type SharedConnectionResult = { sameConnection: boolean; sameAuthProvider: boolean };

const sharedConnectionCases = [
  {
    name: "shares one authenticated connection for repeated profile lookups",
    input: { muximodBaseUrl: "https://shared-workstation.tailnet.ts.net" },
    assert: [returns<EmptyContext, SharedConnectionResult>({ sameConnection: true, sameAuthProvider: true })],
  },
] satisfies readonly OperationCase<"default", SharedConnectionInput, SharedConnectionResult, EmptyContext>[];

const sharedConnectionTable: OperationTable<
  undefined,
  "default",
  SharedConnectionInput,
  SharedConnectionResult,
  EmptyContext
> = {
  defaultFixture: noFixture(),
  cases: sharedConnectionCases,
  execute: (_fixture, input) => {
    const profile: BrowserConnectionProfile = {
      id: "server-shared-123456",
      name: "Shared workstation",
      muximodBaseUrl: input.muximodBaseUrl,
      serverId: "server-shared-123456",
      updatedAt: "2026-08-15T00:00:00.000Z",
    };
    const first = connectionForProfile(profile);
    const second = connectionForProfile(profile);
    return {
      sameConnection: first === second,
      sameAuthProvider: first?.auth === second?.auth,
    };
  },
  observe: () => ({}),
};

type ProfileFixture = { storage: MemoryStorage };
type ProfileInput = Pick<BrowserConnectionProfile, "name" | "muximodBaseUrl" | "serverId">;
type ProfileStep =
  | { type: "save"; input: ProfileInput }
  | { type: "rename"; profileId: string; name: string }
  | { type: "remove"; profileId: string }
  | { type: "set-raw"; key: "v1" | "v2"; value: string }
  | { type: "read"; profileId?: string };
type ProfileContext = { raw: string | null; legacyRaw: string | null };
type ProfileResult = BrowserConnectionProfile[] | BrowserConnectionProfile | null;

const profileFixture = (): FixtureHandle<ProfileFixture> => ({
  fixture: { storage: new MemoryStorage() },
});

const hasProfileNames = (expected: readonly string[]): Assertion<ProfileContext, ProfileResult> => ({
  name: `returns profiles ${expected.join(", ") || "as empty"}`,
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    const profiles = Array.isArray(result.value) ? result.value : result.value ? [result.value] : [];
    expect(profiles.map((profile) => profile.name)).toEqual(expected);
  },
});

const hasProfileIds = (expected: readonly string[]): Assertion<ProfileContext, ProfileResult> => ({
  name: `returns profile ids ${expected.join(", ") || "as empty"}`,
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    const profiles = Array.isArray(result.value) ? result.value : result.value ? [result.value] : [];
    expect(profiles.map((profile) => profile.id)).toEqual(expected);
  },
});

const hasRawProfile = (expected: string | null): Assertion<ProfileContext, ProfileResult> => ({
  name: `stores the v2 profile data ${expected === null ? "as empty" : "in the expected shape"}`,
  check: (ctx) => {
    if (expected === null) {
      expect(ctx.raw).toBeNull();
      return;
    }
    expect(ctx.raw).toBe(expected);
  },
});

const hasNoCredentialFields = (): Assertion<ProfileContext, ProfileResult> => ({
  name: "persists no credential fields",
  check: (ctx) => {
    expect(ctx.raw).not.toContain("key");
    expect(ctx.raw).not.toContain("password");
    expect(ctx.raw).not.toContain("pairingSecret");
  },
});

const profileCases = [
  {
    name: "round-trips multiple named profiles without credentials",
    steps: [
      {
        type: "save",
        input: {
          name: "Workstation",
          muximodBaseUrl: "https://workstation.tailnet.ts.net/",
          serverId: "server-workstation-123456",
        },
      },
      {
        type: "save",
        input: {
          name: "Feature branch",
          muximodBaseUrl: "http://127.0.0.1:4318",
          serverId: "server-feature-123456",
        },
      },
      { type: "read" },
    ],
    assert: [hasProfileNames(["Workstation", "Feature branch"]), hasNoCredentialFields()],
  },
  {
    name: "updates an existing server profile without creating a duplicate",
    steps: [
      {
        type: "save",
        input: {
          name: "Old name",
          muximodBaseUrl: "http://127.0.0.1:4317",
          serverId: "server-feature-123456",
        },
      },
      {
        type: "save",
        input: {
          name: "New name",
          muximodBaseUrl: "http://127.0.0.1:4318",
          serverId: "server-feature-123456",
        },
      },
      { type: "read" },
    ],
    assert: [hasProfileNames(["New name"]), hasProfileIds(["server-feature-123456"])],
  },
  {
    name: "selects the profile requested by the URL identity",
    steps: [
      {
        type: "save",
        input: {
          name: "Feature branch",
          muximodBaseUrl: "http://127.0.0.1:4318",
          serverId: "server-feature-123456",
        },
      },
      {
        type: "save",
        input: {
          name: "Staging",
          muximodBaseUrl: "https://staging.example.ts.net",
          serverId: "server-staging-123456",
        },
      },
      { type: "read", profileId: "server-staging-123456" },
    ],
    assert: [hasProfileNames(["Staging"]), hasProfileIds(["server-staging-123456"])],
  },
  {
    name: "uses the endpoint host and port when the pairing name is blank",
    steps: [
      {
        type: "save",
        input: {
          name: "  ",
          muximodBaseUrl: "http://127.0.0.1:4318",
          serverId: "server-feature-123456",
        },
      },
      { type: "read" },
    ],
    assert: [hasProfileNames(["127.0.0.1:4318"])],
  },
  {
    name: "renames one profile locally",
    steps: [
      {
        type: "save",
        input: {
          name: "Feature branch",
          muximodBaseUrl: "http://127.0.0.1:4318",
          serverId: "server-feature-123456",
        },
      },
      { type: "rename", profileId: "server-feature-123456", name: "Review branch" },
      { type: "read" },
    ],
    assert: [hasProfileNames(["Review branch"])],
  },
  {
    name: "removes only the selected profile",
    steps: [
      {
        type: "save",
        input: {
          name: "Feature branch",
          muximodBaseUrl: "http://127.0.0.1:4318",
          serverId: "server-feature-123456",
        },
      },
      {
        type: "save",
        input: {
          name: "Staging",
          muximodBaseUrl: "https://staging.example.ts.net",
          serverId: "server-staging-123456",
        },
      },
      { type: "remove", profileId: "server-feature-123456" },
      { type: "read" },
    ],
    assert: [hasProfileNames(["Staging"]), hasProfileIds(["server-staging-123456"])],
  },
  {
    name: "migrates a valid single-profile v1 record",
    steps: [
      {
        type: "set-raw",
        key: "v1",
        value: JSON.stringify({
          id: "default",
          name: "Workstation",
          muximodBaseUrl: "https://workstation.tailnet.ts.net",
          serverId: "server-workstation-123456",
          updatedAt: "2026-08-15T00:00:00.000Z",
        }),
      },
      { type: "read" },
    ],
    assert: [hasProfileNames(["Workstation"]), hasProfileIds(["server-workstation-123456"])],
  },
  {
    name: "resets malformed stored data",
    steps: [{ type: "set-raw", key: "v2", value: "not-json" }, { type: "read" }],
    assert: [hasProfileNames([]), hasRawProfile(null)],
  },
  {
    name: "resets a profile with an unsupported endpoint field",
    steps: [
      {
        type: "set-raw",
        key: "v2",
        value: JSON.stringify([
          {
            id: "server-workstation-123456",
            name: "Workstation",
            muximodBaseUrl: "https://workstation.tailnet.ts.net",
            serverId: "server-workstation-123456",
            updatedAt: "2026-08-15T00:00:00.000Z",
            serveUrl: "https://workstation.tailnet.ts.net/",
          },
        ]),
      },
      { type: "read" },
    ],
    assert: [hasProfileNames([]), hasRawProfile(null)],
  },
  {
    name: "rejects an empty rename",
    steps: [
      {
        type: "save",
        input: {
          name: "Feature branch",
          muximodBaseUrl: "http://127.0.0.1:4318",
          serverId: "server-feature-123456",
        },
      },
      { type: "rename", profileId: "server-feature-123456", name: " " },
    ],
    assert: [
      hasError<ProfileContext, ProfileResult>({
        message: "connection profile name must be 1 to 120 characters without line breaks",
      }),
    ],
  },
] satisfies readonly ScenarioCase<"default", ProfileStep, ProfileResult, ProfileContext>[];

const profileTable: ScenarioTable<ProfileFixture, "default", ProfileStep, ProfileResult, ProfileContext> = {
  defaultFixture: profileFixture,
  cases: profileCases,
  execute: (fixture, steps) => {
    let result: ProfileResult = null;
    for (const step of steps) {
      if (step.type === "save") {
        result = saveBrowserConnectionProfile(step.input, fixture.storage);
      }
      if (step.type === "rename") {
        result = renameBrowserConnectionProfile(step.profileId, step.name, fixture.storage);
      }
      if (step.type === "remove") {
        removeBrowserConnectionProfile(step.profileId, fixture.storage);
        result = readBrowserConnectionProfiles(fixture.storage);
      }
      if (step.type === "set-raw") {
        fixture.storage.setItem(
          step.key === "v1" ? "muximo.connection-profile.v1" : "muximo.connection-profiles.v2",
          step.value,
        );
      }
      if (step.type === "read") {
        result = step.profileId
          ? selectBrowserConnectionProfile(step.profileId, fixture.storage)
          : readBrowserConnectionProfiles(fixture.storage);
      }
    }
    return result;
  },
  observe: (fixture) => ({
    raw: fixture.storage.getItem("muximo.connection-profiles.v2"),
    legacyRaw: fixture.storage.getItem("muximo.connection-profile.v1"),
  }),
};

type DefaultNameInput = { muximodBaseUrl: string };
const defaultNameCases = [
  {
    name: "uses a hostname without a port",
    input: { muximodBaseUrl: "https://workstation.tailnet.ts.net" },
    assert: [returns<EmptyContext, string>("workstation.tailnet.ts.net")],
  },
  {
    name: "includes a development port",
    input: { muximodBaseUrl: "http://127.0.0.1:4318" },
    assert: [returns<EmptyContext, string>("127.0.0.1:4318")],
  },
] satisfies readonly OperationCase<"default", DefaultNameInput, string, EmptyContext>[];

const defaultNameTable: OperationTable<undefined, "default", DefaultNameInput, string, EmptyContext> = {
  defaultFixture: noFixture(),
  cases: defaultNameCases,
  execute: (_fixture, input) => defaultConnectionProfileName(input.muximodBaseUrl),
  observe: () => ({}),
};

describe("browser connection profiles", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, normalizeTable);
  runOperationTable(register, connectionTable);
  runOperationTable(register, sharedConnectionTable);
  runOperationTable(register, defaultNameTable);
  runScenarioTable(register, profileTable);
});
