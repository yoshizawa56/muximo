import type { PaneSummary } from "@muximo/contract/api";
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
import { storyPanes } from "../../../-story-fixtures";
import { buildPaneWindows, hasPaneGeometry, type PaneLayoutWindow } from "./-pane-layout-overlay-view";

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
  {
    name: "rejects a pane that extends past the window edge",
    input: { geometry: { ...geometry, left: 100 } },
    assert: [returns<Context, boolean>(false)],
  },
] satisfies readonly OperationCase<"default", GeometryInput, boolean, Context>[];

const geometryTable: OperationTable<undefined, "default", GeometryInput, boolean, Context> = {
  defaultFixture: noFixture(),
  cases: geometryCases,
  execute: (_fixture, input) => hasPaneGeometry(input.geometry),
  observe: () => ({}),
};

type WindowInput = { panes: PaneSummary[] };

function paneSummary(overrides: Partial<PaneSummary>): PaneSummary {
  const base = storyPanes[0];
  if (!base) throw new Error("Missing pane story fixture");
  return { ...base, windowWidth: 160, windowHeight: 48, ...overrides };
}

const layoutOrderingAssertion: Assertion<Context, PaneLayoutWindow[]> = {
  name: "orders windows and panes by their tmux positions",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value.map((window) => window.windowId)).toEqual(["@0", "@1"]);
    expect(result.value[0]?.panes.map((pane) => pane.id)).toEqual(["pane-left", "pane-right"]);
    expect(result.value[0]?.hasGeometry).toBe(true);
  },
};

const narrowGeometryAssertion: Assertion<Context, PaneLayoutWindow[]> = {
  name: "keeps a narrow but valid split as a geometric layout",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value[0]?.hasGeometry).toBe(true);
    expect(result.value[0]?.panes).toHaveLength(2);
  },
};

const invalidGeometryAssertion: Assertion<Context, PaneLayoutWindow[]> = {
  name: "falls back when a window snapshot cannot describe a valid layout",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.hasGeometry).toBe(false);
  },
};

const sessionScopedWindowAssertion: Assertion<Context, PaneLayoutWindow[]> = {
  name: "keeps identical window ids separate across tmux sessions",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value.map((window) => `${window.sessionName}:${window.windowId}`)).toEqual(["alpha:@0", "beta:@0"]);
  },
};

const uniquePaneAssertion: Assertion<Context, PaneLayoutWindow[]> = {
  name: "does not render duplicated pane records twice",
  check: (_ctx, result) => {
    if (!result.ok) throw result.error;
    expect(result.value[0]?.panes.map((pane) => pane.id)).toEqual(["pane-left"]);
  },
};

const windowCases = [
  {
    name: "keeps the live window order and pane order deterministic",
    input: {
      panes: [
        paneSummary({
          id: "pane-right",
          hostPaneId: "%2",
          windowId: "@0",
          windowIndex: 0,
          paneIndex: 1,
          left: 80,
          top: 0,
          width: 80,
          height: 48,
        }),
        paneSummary({
          id: "pane-window-one",
          hostPaneId: "%3",
          windowId: "@1",
          windowIndex: 1,
          paneIndex: 0,
          left: 0,
          top: 0,
          width: 160,
          height: 48,
        }),
        paneSummary({
          id: "pane-left",
          hostPaneId: "%1",
          windowId: "@0",
          windowIndex: 0,
          paneIndex: 0,
          left: 0,
          top: 0,
          width: 80,
          height: 48,
        }),
      ],
    },
    assert: [layoutOrderingAssertion],
  },
  {
    name: "preserves a split even when one pane is narrow on the phone",
    input: {
      panes: [
        paneSummary({
          id: "pane-narrow",
          hostPaneId: "%1",
          windowId: "@0",
          windowIndex: 0,
          paneIndex: 0,
          left: 0,
          top: 0,
          width: 8,
          height: 48,
        }),
        paneSummary({
          id: "pane-wide",
          hostPaneId: "%2",
          windowId: "@0",
          windowIndex: 0,
          paneIndex: 1,
          left: 8,
          top: 0,
          width: 152,
          height: 48,
        }),
      ],
    },
    assert: [narrowGeometryAssertion],
  },
  {
    name: "falls back from overlapping panes instead of hiding one pane",
    input: {
      panes: [
        paneSummary({
          id: "pane-left",
          hostPaneId: "%1",
          windowId: "@0",
          windowIndex: 0,
          paneIndex: 0,
          left: 0,
          top: 0,
          width: 100,
          height: 48,
        }),
        paneSummary({
          id: "pane-right",
          hostPaneId: "%2",
          windowId: "@0",
          windowIndex: 0,
          paneIndex: 1,
          left: 60,
          top: 0,
          width: 100,
          height: 48,
        }),
      ],
    },
    assert: [invalidGeometryAssertion],
  },
  {
    name: "falls back when panes disagree about the live window size",
    input: {
      panes: [
        paneSummary({
          id: "pane-left",
          hostPaneId: "%1",
          windowId: "@0",
          windowIndex: 0,
          paneIndex: 0,
          left: 0,
          top: 0,
          width: 80,
          height: 48,
          windowWidth: 160,
          windowHeight: 48,
        }),
        paneSummary({
          id: "pane-right",
          hostPaneId: "%2",
          windowId: "@0",
          windowIndex: 0,
          paneIndex: 1,
          left: 80,
          top: 0,
          width: 80,
          height: 48,
          windowWidth: 161,
          windowHeight: 48,
        }),
      ],
    },
    assert: [invalidGeometryAssertion],
  },
  {
    name: "scopes windows by session before sorting them",
    input: {
      panes: [
        paneSummary({
          id: "pane-beta",
          hostPaneId: "%2",
          sessionName: "beta",
          windowId: "@0",
          windowIndex: undefined,
          paneIndex: 0,
        }),
        paneSummary({
          id: "pane-alpha",
          hostPaneId: "%1",
          sessionName: "alpha",
          windowId: "@0",
          windowIndex: undefined,
          paneIndex: 0,
        }),
      ],
    },
    assert: [sessionScopedWindowAssertion],
  },
  {
    name: "ignores duplicate stable pane records",
    input: {
      panes: [
        paneSummary({
          id: "pane-left",
          hostPaneId: "%1",
          windowId: "@0",
          windowIndex: 0,
          paneIndex: 0,
          left: 0,
          top: 0,
          width: 160,
          height: 48,
        }),
        paneSummary({
          id: "pane-left",
          hostPaneId: "%1",
          windowId: "@0",
          windowIndex: 0,
          paneIndex: 0,
          left: 0,
          top: 0,
          width: 160,
          height: 48,
        }),
      ],
    },
    assert: [uniquePaneAssertion],
  },
] satisfies readonly OperationCase<"default", WindowInput, PaneLayoutWindow[], Context>[];

const windowTable: OperationTable<undefined, "default", WindowInput, PaneLayoutWindow[], Context> = {
  defaultFixture: noFixture(),
  cases: windowCases,
  execute: (_fixture, input) => buildPaneWindows(input.panes),
  observe: () => ({}),
};

describe("pane layout geometry", () => {
  runOperationTable(it as unknown as TestRegistrar, geometryTable);
  runOperationTable(it as unknown as TestRegistrar, windowTable);
});
