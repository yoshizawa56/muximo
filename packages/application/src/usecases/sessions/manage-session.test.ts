import {
  type FixtureHandle,
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { ManageSessionResult } from "../../ports/application.js";
import type { MuximodSessionManagementPort } from "../../ports/host.js";
import { manageSession } from "./manage-session.js";

type Input = {
  name: string;
  exists: boolean;
  managedSessionId?: string;
};

type Fixture = {
  host: MuximodSessionManagementPort;
  input: Input | undefined;
  calls: string[];
};

type Context = {
  calls: readonly string[];
};

const cases = [
  {
    name: "adopts an existing unmanaged session with a generated identity",
    input: { name: " desktop ", exists: true },
    assert: [
      returns<Context, ManageSessionResult>({ name: "desktop", changed: true }),
      hasObserved<Context, ManageSessionResult>("calls", [
        "hasSession:desktop",
        "findManagedSessionId:desktop",
        "newId",
        "configureManagedSession:desktop:managed-session-1",
      ]),
    ],
  },
  {
    name: "keeps an already managed session idempotent",
    input: { name: "desktop", exists: true, managedSessionId: "managed-session-1" },
    assert: [
      returns<Context, ManageSessionResult>({ name: "desktop", changed: false }),
      hasObserved<Context, ManageSessionResult>("calls", ["hasSession:desktop", "findManagedSessionId:desktop"]),
    ],
  },
  {
    name: "rejects a session that no longer exists",
    input: { name: "missing", exists: false },
    assert: [
      hasError<Context, ManageSessionResult>({
        code: "session_not_found",
        message: "terminal host session does not exist: missing",
      }),
      hasObserved<Context, ManageSessionResult>("calls", ["hasSession:missing"]),
    ],
  },
] satisfies readonly OperationCase<"default", Input, ManageSessionResult, Context>[];

const table: OperationTable<Fixture, "default", Input, ManageSessionResult, Context> = {
  defaultFixture: createFixture,
  cases,
  execute: async (fixture, input) => {
    fixture.input = input;
    return manageSession(input, fixture.host);
  },
  observe: (fixture) => ({ calls: [...fixture.calls] }),
};

function createFixture(): FixtureHandle<Fixture> {
  const fixture = {
    input: undefined as Input | undefined,
    calls: [] as string[],
  } as Fixture;
  fixture.host = {
    newId: () => {
      fixture.calls.push("newId");
      return "managed-session-1";
    },
    hasSession: async (target) => {
      fixture.calls.push(`hasSession:${target}`);
      return fixture.input?.exists ?? false;
    },
    findManagedSessionId: async (target) => {
      fixture.calls.push(`findManagedSessionId:${target}`);
      return fixture.input?.managedSessionId;
    },
    configureManagedSession: async (target, managedSessionId) => {
      fixture.calls.push(`configureManagedSession:${target}:${managedSessionId}`);
    },
  };
  return { fixture };
}

describe("manage session usecase", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
