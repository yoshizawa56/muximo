import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { errorMessage } from "./app-error-view";

type Input = { error: unknown };
type Context = {};

const cases = [
  {
    name: "formats an Error",
    input: { error: new Error("muximod is unavailable") },
    assert: [returns<Context, string>("muximod is unavailable")],
  },
  { name: "formats a string", input: { error: "route failed" }, assert: [returns<Context, string>("route failed")] },
  {
    name: "formats an object",
    input: { error: { code: "ECONNREFUSED" } },
    assert: [returns<Context, string>('{"code":"ECONNREFUSED"}')],
  },
  {
    name: "formats null as an unknown error",
    input: { error: null },
    assert: [returns<Context, string>("Unknown error")],
  },
] satisfies readonly OperationCase<"default", Input, string, Context>[];

const table: OperationTable<undefined, "default", Input, string, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => errorMessage(input.error),
  observe: () => ({}),
};

describe("errorMessage", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
