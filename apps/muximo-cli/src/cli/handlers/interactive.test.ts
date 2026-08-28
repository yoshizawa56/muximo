import type { TmuxNewSessionResult } from "@muximo/infrastructure/cli-client";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { CliIo, CliTmuxNewSessionInput } from "../commands/types.js";
import { createInteractiveHandlers } from "./interactive.js";

type InteractiveFixtureKey = "detached" | "attached";

type InteractiveFixture = {
  calls: CliTmuxNewSessionInput[];
  output: string[];
  events: string[];
  handlers: ReturnType<typeof createInteractiveHandlers>;
};

type InteractiveContext = {
  calls: readonly CliTmuxNewSessionInput[];
  output: string;
  events: readonly string[];
};

const input: CliTmuxNewSessionInput = { name: "review", cwd: "/workspace", detached: false };

const cases = [
  {
    name: "presents a detached tmux session and returns success",
    fixture: "detached",
    input,
    assert: [
      returns<InteractiveContext, number>(0),
      hasObserved<InteractiveContext, number>("calls", [input]),
      hasObserved<InteractiveContext, number>(
        "output",
        "muximo: created managed tmux session 'review' (managed-session-1)\n",
      ),
      hasObserved<InteractiveContext, number>("events", ["output"]),
    ],
  },
  {
    name: "presents an attached tmux session before attaching and preserves its exit status",
    fixture: "attached",
    input,
    assert: [
      returns<InteractiveContext, number>(23),
      hasObserved<InteractiveContext, number>("calls", [input]),
      hasObserved<InteractiveContext, number>(
        "output",
        "muximo: created managed tmux session 'review' (managed-session-1)\n",
      ),
      hasObserved<InteractiveContext, number>("events", ["output", "attach"]),
    ],
  },
] satisfies readonly OperationCase<InteractiveFixtureKey, CliTmuxNewSessionInput, number, InteractiveContext>[];

const table: OperationTable<
  InteractiveFixture,
  InteractiveFixtureKey,
  CliTmuxNewSessionInput,
  number,
  InteractiveContext
> = {
  defaultFixture: () => createFixture("detached"),
  fixtures: {
    detached: () => createFixture("detached"),
    attached: () => createFixture("attached"),
  },
  cases,
  execute: (fixture, operationInput) => fixture.handlers.tmuxNewSession(operationInput),
  observe: (fixture) => ({
    calls: [...fixture.calls],
    output: fixture.output.join(""),
    events: [...fixture.events],
  }),
};

function createFixture(attachmentState: TmuxNewSessionResult["attachment"]["state"]): { fixture: InteractiveFixture } {
  const calls: CliTmuxNewSessionInput[] = [];
  const output: string[] = [];
  const events: string[] = [];
  const io = {
    out: {
      write: (value: string) => {
        events.push("output");
        output.push(value);
      },
    },
    err: { write: () => undefined },
  } as unknown as CliIo;
  const attachment: TmuxNewSessionResult["attachment"] =
    attachmentState === "detached"
      ? { state: "detached" }
      : {
          state: "attached",
          attach: () => {
            events.push("attach");
            return 23;
          },
        };
  const result: TmuxNewSessionResult = {
    created: { name: "review", managedSessionId: "managed-session-1" },
    attachment,
  };
  return {
    fixture: {
      calls,
      output,
      events,
      handlers: createInteractiveHandlers({
        shell: { execute: async () => ({ process: { code: 0, interrupted: false } }) },
        tmux: {
          execute: async (operationInput) => {
            calls.push(operationInput);
            return result;
          },
        },
        manageSession: { execute: async () => ({ name: "review", changed: true }) },
        io,
      }),
    },
  };
}

describe("interactive CLI handlers", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
