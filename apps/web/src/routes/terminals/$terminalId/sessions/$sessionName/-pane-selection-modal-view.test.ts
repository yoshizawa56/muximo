import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { isOutsideModalTarget } from "./-pane-selection-modal-view";

type ModalInput = {
  modal: "present" | "missing";
  target: "child" | "backdrop" | "none";
};
type Context = {};

const modalCases = [
  {
    name: "closes when the pointer lands outside the modal",
    input: { modal: "present", target: "backdrop" },
    assert: [returns<Context, boolean>(true)],
  },
  {
    name: "keeps the modal open for a child control",
    input: { modal: "present", target: "child" },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "does not close when the pointer target is missing",
    input: { modal: "present", target: "none" },
    assert: [returns<Context, boolean>(false)],
  },
  {
    name: "does not close before the modal is mounted",
    input: { modal: "missing", target: "backdrop" },
    assert: [returns<Context, boolean>(false)],
  },
] satisfies readonly OperationCase<"default", ModalInput, boolean, Context>[];

const modalTable: OperationTable<undefined, "default", ModalInput, boolean, Context> = {
  defaultFixture: noFixture(),
  cases: modalCases,
  execute: (_fixture, input) => {
    const child = {};
    const target = input.target === "none" ? null : input.target === "child" ? child : {};
    const modal = input.modal === "present" ? { contains: (candidate: unknown) => candidate === child } : null;
    return isOutsideModalTarget(target, modal);
  },
  observe: () => ({}),
};

describe("pane selection modal", () => {
  runOperationTable(it as unknown as TestRegistrar, modalTable);
});
