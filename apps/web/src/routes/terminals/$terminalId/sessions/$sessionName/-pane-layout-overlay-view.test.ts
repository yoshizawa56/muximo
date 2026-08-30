import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { hasPaneGeometry, paneLayoutNeedsCompactTargets } from "./-pane-layout-overlay-view";

type Geometry = {
  left: number;
  top: number;
  width: number;
  height: number;
  windowWidth: number;
  windowHeight: number;
};

const geometry: Geometry = {
  left: 0,
  top: 0,
  width: 80,
  height: 24,
  windowWidth: 160,
  windowHeight: 48,
};

type GeometryInput = { geometry: Geometry };
type Context = {};

const geometryCases = [
  {
    name: "accepts panes anchored at the tmux origin",
    input: { geometry },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "rejects negative positions",
    input: { geometry: { ...geometry, left: -1 } },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "rejects zero dimensions",
    input: { geometry: { ...geometry, width: 0 } },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "rejects a zero-sized window",
    input: { geometry: { ...geometry, windowHeight: 0 } },
    assert: [returns<Context, boolean>(false)],
  },
] satisfies readonly OperationCase<"default", GeometryInput, boolean, Context>[];

const geometryTable: OperationTable<undefined, "default", GeometryInput, boolean, Context> = {
  defaultFixture: noFixture(),
  cases: geometryCases,
  execute: (_fixture, input) => hasPaneGeometry(input.geometry),
  observe: () => ({}),
};

type CompactInput = {
  panes: Geometry[];
  windowWidth: number | undefined;
  windowHeight: number;
};

const compactCases = [
  {
    name: "falls back when a geometric pane is too small to tap",
    input: {
      panes: [
        { ...geometry, width: 8, windowWidth: 160 },
        { ...geometry, top: 24, height: 24, windowHeight: 48 },
      ],
      windowWidth: 160,
      windowHeight: 48,
    },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "falls back for a compact window",
    input: {
      panes: [
        { ...geometry, width: 10, windowWidth: 80 },
        { ...geometry, top: 12, height: 12, windowHeight: 24 },
      ],
      windowWidth: 80,
      windowHeight: 24,
    },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "keeps a sufficiently large layout expanded",
    input: { panes: [geometry], windowWidth: 160, windowHeight: 48 },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "does not compact without a valid window size",
    input: { panes: [geometry], windowWidth: undefined, windowHeight: 48 },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "does not compact with a zero window height",
    input: { panes: [geometry], windowWidth: 160, windowHeight: 0 },
    assert: [returns<Context, boolean>(false)],
  },
] satisfies readonly OperationCase<"default", CompactInput, boolean, Context>[];

const compactTable: OperationTable<undefined, "default", CompactInput, boolean, Context> = {
  defaultFixture: noFixture(),
  cases: compactCases,
  execute: (_fixture, input) => paneLayoutNeedsCompactTargets(input.panes, input.windowWidth, input.windowHeight),
  observe: () => ({}),
};

describe("pane layout geometry", () => {
  runOperationTable(it as unknown as TestRegistrar, geometryTable);
  runOperationTable(it as unknown as TestRegistrar, compactTable);
});
