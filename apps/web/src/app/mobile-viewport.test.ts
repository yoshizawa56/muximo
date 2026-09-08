import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { type MobileViewportHeightInput, resolveMobileViewportHeight } from "./mobile-viewport";

type Context = {};

const cases = [
  {
    name: "uses the visual viewport while the keyboard is controlling the layout",
    input: { visualViewportHeight: 430, layoutViewportHeight: 844, recoveringFromKeyboard: false },
    assert: [returns<Context, number>(430)],
  },
  {
    name: "uses the recovered layout viewport during keyboard dismissal",
    input: { visualViewportHeight: 430, layoutViewportHeight: 844, recoveringFromKeyboard: true },
    assert: [returns<Context, number>(844)],
  },
  {
    name: "holds the recovered baseline during the finite stale resize guard",
    input: {
      visualViewportHeight: 430,
      layoutViewportHeight: 430,
      minimumHeight: 844,
    },
    assert: [returns<Context, number>(844)],
  },
  {
    name: "does not grow beyond the visual viewport during ordinary browser resizing",
    input: { visualViewportHeight: 780, layoutViewportHeight: 844, recoveringFromKeyboard: false },
    assert: [returns<Context, number>(780)],
  },
  {
    name: "falls back to the layout viewport when visual viewport data is unavailable",
    input: { visualViewportHeight: undefined, layoutViewportHeight: 844 },
    assert: [returns<Context, number>(844)],
  },
] satisfies readonly OperationCase<"default", MobileViewportHeightInput, number, Context>[];

const table: OperationTable<undefined, "default", MobileViewportHeightInput, number, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => resolveMobileViewportHeight(input),
  observe: () => ({}),
};

describe("mobile viewport height resolution", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
