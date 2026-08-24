import {
  type Assertion,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { classifyPinchDirection, isBrowserZoomKey, isZoomInKey } from "./-window-map-gesture";

type Context = {};

const pinchCases = [
  {
    name: "classifies a deliberate pinch out",
    input: { initial: 120, current: 150 },
    assert: [returns<Context, "out" | "in" | null>("out")],
  },
  {
    name: "classifies a deliberate pinch in",
    input: { initial: 150, current: 120 },
    assert: [returns<Context, "out" | "in" | null>("in")],
  },
  {
    name: "ignores movement below the deliberate threshold",
    input: { initial: 120, current: 141 },
    assert: [returns<Context, "out" | "in" | null>(null)],
  },
] satisfies readonly OperationCase<"default", { initial: number; current: number }, "out" | "in" | null, Context>[];

const pinchTable: OperationTable<
  undefined,
  "default",
  { initial: number; current: number },
  "out" | "in" | null,
  Context
> = {
  defaultFixture: noFixture(),
  cases: pinchCases,
  execute: (_fixture, input) => classifyPinchDirection(input.initial, input.current),
  observe: () => ({}),
};

type ZoomInput = { key: string; ctrlKey: boolean; metaKey: boolean };
type ZoomResult = { isBrowserZoom: boolean; isZoomIn: boolean };

const matchesZoomResult = (expected: Partial<ZoomResult>): Assertion<Context, ZoomResult> => ({
  name: "matches browser zoom classification",
  check: (_ctx, result) => {
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toMatchObject(expected);
  },
});

const zoomCases = [
  {
    name: "recognizes plus with a control modifier",
    input: { key: "+", ctrlKey: true, metaKey: false },
    assert: [matchesZoomResult({ isBrowserZoom: true, isZoomIn: true })],
  },
  {
    name: "recognizes equals with a meta modifier",
    input: { key: "=", ctrlKey: false, metaKey: true },
    assert: [matchesZoomResult({ isBrowserZoom: true, isZoomIn: true })],
  },
  {
    name: "recognizes minus with a control modifier",
    input: { key: "-", ctrlKey: true, metaKey: false },
    assert: [matchesZoomResult({ isBrowserZoom: true, isZoomIn: false })],
  },
  {
    name: "recognizes zero with a meta modifier",
    input: { key: "0", ctrlKey: false, metaKey: true },
    assert: [matchesZoomResult({ isBrowserZoom: true, isZoomIn: false })],
  },
  {
    name: "ignores an unmodified plus key",
    input: { key: "+", ctrlKey: false, metaKey: false },
    assert: [matchesZoomResult({ isBrowserZoom: false })],
  },
] satisfies readonly OperationCase<"default", ZoomInput, ZoomResult, Context>[];

const zoomTable: OperationTable<undefined, "default", ZoomInput, ZoomResult, Context> = {
  defaultFixture: noFixture(),
  cases: zoomCases,
  execute: (_fixture, input) => ({
    isBrowserZoom: isBrowserZoomKey(input),
    isZoomIn: isZoomInKey(input),
  }),
  observe: () => ({}),
};

describe("window map gesture", () => {
  runOperationTable(it as unknown as TestRegistrar, pinchTable);
  runOperationTable(it as unknown as TestRegistrar, zoomTable);
});
