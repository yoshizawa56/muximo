import type { ManageSessionResult } from "@muximo/application";
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
import type { CliIo, CliTmuxManageSessionInput } from "../commands/types.js";
import { createInteractiveHandlers } from "./interactive.js";

type FixtureKey = "changed" | "unchanged";
type Context = { output: string };
type Fixture = {
  output: string[];
  handlers: ReturnType<typeof createInteractiveHandlers>;
};

const cases = [
  {
    name: "reports an existing session adopted into muximo",
    fixture: "changed",
    input: { name: "desktop" },
    assert: [
      returns<Context, number>(0),
      hasObserved<Context, number>("output", "[muximo-cli] managed existing tmux session 'desktop'\n"),
    ],
  },
  {
    name: "reports an existing session that was already managed",
    fixture: "unchanged",
    input: { name: "desktop" },
    assert: [
      returns<Context, number>(0),
      hasObserved<Context, number>("output", "[muximo-cli] tmux session 'desktop' is already managed\n"),
    ],
  },
] satisfies readonly OperationCase<FixtureKey, CliTmuxManageSessionInput, number, Context>[];

const table: OperationTable<Fixture, FixtureKey, CliTmuxManageSessionInput, number, Context> = {
  defaultFixture: () => createFixture({ name: "desktop", changed: true }),
  fixtures: {
    changed: () => createFixture({ name: "desktop", changed: true }),
    unchanged: () => createFixture({ name: "desktop", changed: false }),
  },
  cases,
  execute: (fixture, input) => fixture.handlers.tmuxManageSession(input),
  observe: (fixture) => ({ output: fixture.output.join("") }),
};

function createFixture(result: ManageSessionResult): FixtureHandle<Fixture> {
  const output: string[] = [];
  const io = {
    out: { write: (value: string) => output.push(value) },
    err: { write: () => undefined },
  } as unknown as CliIo;
  return {
    fixture: {
      output,
      handlers: createInteractiveHandlers({
        shell: { execute: async () => ({ process: { started: true, code: 0, interrupted: false } }) },
        tmux: {
          execute: async () => ({
            created: { name: "desktop", managedSessionId: "managed-session-1" },
            attachment: { state: "detached" },
          }),
        },
        manageSession: { execute: async () => result },
        io,
      }),
    },
  };
}

describe("tmux session management CLI handler", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
