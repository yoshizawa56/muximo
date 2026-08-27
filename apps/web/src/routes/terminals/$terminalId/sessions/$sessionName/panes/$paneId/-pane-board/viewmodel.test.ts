import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { storyPanes } from "../../../../../../-story-fixtures";
import { paneStateLabel } from "../../../-pane-state";
import type { PaneSummary } from "./viewmodel";
import { selectedTargetFromPaneId } from "./viewmodel";

type Input = { state: "waiting_input" | "waiting_approval" | "running" | "failed" };
type Context = {};

const cases = [
  {
    name: "labels input waiting",
    input: { state: "waiting_input" as const },
    assert: [returns<Context, string>("Waiting for input")],
  },
  {
    name: "labels approval waiting",
    input: { state: "waiting_approval" as const },
    assert: [returns<Context, string>("Waiting for approval")],
  },
  { name: "labels running", input: { state: "running" as const }, assert: [returns<Context, string>("Running")] },
  { name: "labels failure", input: { state: "failed" as const }, assert: [returns<Context, string>("Failed")] },
] satisfies readonly OperationCase<"default", Input, string, Context>[];

const table: OperationTable<undefined, "default", Input, string, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => paneStateLabel(input.state),
  observe: () => ({}),
};

type SelectionInput = {
  panes: readonly PaneSummary[];
  selectedPaneId?: string;
};

const selectionCases = [
  {
    name: "resolves the volatile host target from the stable route pane id",
    input: { panes: storyPanes, selectedPaneId: "pane-build" },
    assert: [returns<Context, string>("%1")],
  },
  {
    name: "returns an empty target while the route pane is unavailable",
    input: { panes: storyPanes, selectedPaneId: "missing-pane" },
    assert: [returns<Context, string>("")],
  },
] satisfies readonly OperationCase<"default", SelectionInput, string, Context>[];

const selectionTable: OperationTable<undefined, "default", SelectionInput, string, Context> = {
  defaultFixture: noFixture(),
  cases: selectionCases,
  execute: (_fixture, input) => selectedTargetFromPaneId(input.panes, input.selectedPaneId),
  observe: () => ({}),
};

describe("pane board view model helpers", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
  runOperationTable(it as unknown as TestRegistrar, selectionTable);
});
