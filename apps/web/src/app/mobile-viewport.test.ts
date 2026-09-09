import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  type MobileViewportHeightInput,
  resolveMobileViewportHeight,
  resolveStaleResizeGuard,
  type StaleResizeGuardState,
} from "./mobile-viewport";

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
    name: "returns to a smaller visual viewport after the recovery floor expires",
    input: { visualViewportHeight: 430, layoutViewportHeight: 430, recoveringFromKeyboard: false },
    assert: [returns<Context, number>(430)],
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

type StaleResizeGuardInput = { now: number; guardUntil: number; recoveryFloor: number | null };
const staleResizeGuardCases = [
  {
    name: "keeps the recovery floor before expiry",
    input: { now: 1_999, guardUntil: 2_000, recoveryFloor: 844 },
    assert: [returns<Context, StaleResizeGuardState>({ active: true, minimumHeight: 844 })],
  },
  {
    name: "expires the recovery floor at the boundary",
    input: { now: 2_000, guardUntil: 2_000, recoveryFloor: 844 },
    assert: [returns<Context, StaleResizeGuardState>({ active: false, minimumHeight: undefined })],
  },
  {
    name: "allows a smaller viewport after expiry",
    input: { now: 2_001, guardUntil: 2_000, recoveryFloor: 844 },
    assert: [returns<Context, StaleResizeGuardState>({ active: false, minimumHeight: undefined })],
  },
] satisfies readonly OperationCase<"default", StaleResizeGuardInput, StaleResizeGuardState, Context>[];

const staleResizeGuardTable: OperationTable<
  undefined,
  "default",
  StaleResizeGuardInput,
  StaleResizeGuardState,
  Context
> = {
  defaultFixture: noFixture(),
  cases: staleResizeGuardCases,
  execute: (_fixture, input) => resolveStaleResizeGuard(input.now, input.guardUntil, input.recoveryFloor),
  observe: () => ({}),
};

describe("mobile viewport height resolution", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
  runOperationTable(register, staleResizeGuardTable);
});
