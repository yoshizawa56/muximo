import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  type CustomKeyboardTerminalAction,
  type CustomKeyboardTerminalActionHandlers,
  routeCustomKeyboardTerminalAction,
} from "./terminal-actions";

type ActionFixture = {
  calls: string[];
  handlers: CustomKeyboardTerminalActionHandlers;
};

type ActionContext = {
  calls: readonly string[];
};

function actionFixture(): FixtureHandle<ActionFixture> {
  const calls: string[] = [];
  const handlers: CustomKeyboardTerminalActionHandlers = {
    "enter-copy-mode": () => calls.push("enter-copy-mode"),
    "paste-from-clipboard": () => calls.push("paste-from-clipboard"),
    "paste-from-tmux-buffer": () => calls.push("paste-from-tmux-buffer"),
  };
  return { fixture: { calls, handlers } };
}

const actionCases = [
  {
    name: "routes copy mode to its dedicated handler",
    input: "enter-copy-mode",
    assert: [hasObserved<ActionContext, undefined>("calls", ["enter-copy-mode"])],
  },
  {
    name: "routes clipboard paste to its dedicated handler",
    input: "paste-from-clipboard",
    assert: [hasObserved<ActionContext, undefined>("calls", ["paste-from-clipboard"])],
  },
  {
    name: "routes tmux buffer paste to its dedicated handler",
    input: "paste-from-tmux-buffer",
    assert: [hasObserved<ActionContext, undefined>("calls", ["paste-from-tmux-buffer"])],
  },
] satisfies readonly OperationCase<"default", CustomKeyboardTerminalAction, undefined, ActionContext>[];

const actionTable: OperationTable<ActionFixture, "default", CustomKeyboardTerminalAction, undefined, ActionContext> = {
  defaultFixture: actionFixture,
  cases: actionCases,
  execute: (fixture, action) => {
    routeCustomKeyboardTerminalAction(action, fixture.handlers);
    return undefined;
  },
  observe: (fixture) => ({ calls: [...fixture.calls] }),
};

describe("custom keyboard terminal action routing", () => {
  runOperationTable(it as unknown as TestRegistrar, actionTable);
});
