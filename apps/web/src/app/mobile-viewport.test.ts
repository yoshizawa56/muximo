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
  isMobileViewportTextEntryElement,
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

type FocusOutTarget = {
  tagName: string;
  type?: string;
  contenteditable?: string;
  isContentEditable?: boolean;
} | null;
const focusOutCases = [
  {
    name: "recovers after a text input loses focus",
    input: { tagName: "INPUT", type: "text" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "recovers after a number input loses focus",
    input: { tagName: "INPUT", type: "number" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "does not recover after a checkbox input loses focus",
    input: { tagName: "INPUT", type: "checkbox" },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "does not recover after a range input loses focus",
    input: { tagName: "INPUT", type: "range" },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "uses text as the default input type",
    input: { tagName: "INPUT" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "recovers after a select loses focus",
    input: { tagName: "SELECT" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "recovers after a textarea loses focus",
    input: { tagName: "TEXTAREA" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "recovers after a true contenteditable element loses focus",
    input: { tagName: "DIV", contenteditable: "true" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "recovers after an empty contenteditable element loses focus",
    input: { tagName: "DIV", contenteditable: "" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "recovers after a plaintext-only contenteditable element loses focus",
    input: { tagName: "DIV", contenteditable: "plaintext-only" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "recovers after an inherited contenteditable element loses focus",
    input: { tagName: "DIV", isContentEditable: true },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "does not recover after a button loses focus",
    input: { tagName: "BUTTON" },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "does not recover after a link loses focus",
    input: { tagName: "A" },
    assert: [returns<Context, boolean>(false)],
  },
  { name: "does not recover after focus leaves the document", input: null, assert: [returns<Context, boolean>(false)] },
] satisfies readonly OperationCase<"default", FocusOutTarget, boolean, Context>[];

const focusOutTable: OperationTable<undefined, "default", FocusOutTarget, boolean, Context> = {
  defaultFixture: noFixture(),
  cases: focusOutCases,
  execute: (_fixture, input) =>
    isMobileViewportTextEntryElement(
      input === null
        ? null
        : ({
            tagName: input.tagName,
            getAttribute: (name: string) =>
              name === "contenteditable"
                ? (input.contenteditable ?? null)
                : name === "type"
                  ? (input.type ?? null)
                  : null,
            isContentEditable: input.isContentEditable ?? false,
          } as unknown as Element),
    ),
  observe: () => ({}),
};

describe("mobile viewport height resolution", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
  runOperationTable(register, staleResizeGuardTable);
  runOperationTable(register, focusOutTable);
});
