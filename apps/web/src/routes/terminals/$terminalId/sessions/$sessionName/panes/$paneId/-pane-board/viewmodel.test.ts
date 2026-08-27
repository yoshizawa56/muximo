import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { paneStateLabel } from "../../../-pane-state";

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

describe("pane board view model helpers", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
