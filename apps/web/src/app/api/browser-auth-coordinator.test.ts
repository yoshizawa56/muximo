import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { type BrowserAuthSession, createBrowserAuthCoordinator } from "./browser-auth-coordinator";

type AuthFixture = {
  coordinator: ReturnType<typeof createBrowserAuthCoordinator>;
  loadCalls: number;
};

type AuthInput = {
  initialCallCount: number;
  invalidateAfterInitial: boolean;
};

type AuthResult = {
  initialTokens: string[];
  afterInvalidationToken: string | null;
};

type AuthContext = { loadCalls: number };

const session = (loadCalls: number): BrowserAuthSession => ({
  serverId: "server-test-00000000",
  deviceId: "device-test-00000000",
  accessToken: `access-token-${loadCalls}`,
  expiresAt: "2099-08-15T00:00:00.000Z",
});

const authFixture = (): FixtureHandle<AuthFixture> => {
  let loadCalls = 0;
  const coordinator = createBrowserAuthCoordinator(async () => {
    loadCalls += 1;
    await Promise.resolve();
    return session(loadCalls);
  });
  return {
    fixture: {
      coordinator,
      get loadCalls() {
        return loadCalls;
      },
    },
  };
};

const cases = [
  {
    name: "shares one session acquisition across concurrent callers",
    input: { initialCallCount: 5, invalidateAfterInitial: false },
    assert: [
      returns<AuthContext, AuthResult>({
        initialTokens: ["access-token-1", "access-token-1", "access-token-1", "access-token-1", "access-token-1"],
        afterInvalidationToken: null,
      }),
      hasObserved<AuthContext, AuthResult>("loadCalls", 1),
    ],
  },
  {
    name: "reuses a fresh session until it is invalidated",
    input: { initialCallCount: 1, invalidateAfterInitial: true },
    assert: [
      returns<AuthContext, AuthResult>({
        initialTokens: ["access-token-1"],
        afterInvalidationToken: "access-token-2",
      }),
      hasObserved<AuthContext, AuthResult>("loadCalls", 2),
    ],
  },
] satisfies readonly OperationCase<"default", AuthInput, AuthResult, AuthContext>[];

const table: OperationTable<AuthFixture, "default", AuthInput, AuthResult, AuthContext> = {
  defaultFixture: authFixture,
  cases,
  execute: async (fixture, input) => {
    const initialTokens = await Promise.all(
      Array.from({ length: input.initialCallCount }, () => fixture.coordinator.getAccessToken()),
    );
    let afterInvalidationToken: string | null = null;
    if (input.invalidateAfterInitial) {
      fixture.coordinator.invalidateAccessToken();
      afterInvalidationToken = await fixture.coordinator.getAccessToken();
    }
    return { initialTokens, afterInvalidationToken };
  },
  observe: (fixture) => ({ loadCalls: fixture.loadCalls }),
};

describe("browser authentication coordination", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
