import { describe, it } from "vitest";
import {
  hasError,
  noFixture,
  returns,
  runOperationTable,
  type OperationCase,
  type OperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { parseDevServeProvider } from "./dev-command.js";

type Input = { args: string[] };
type Result = string | undefined;
type Context = {};

const cases = [
  {
    name: "runs the local stack without an exposure provider by default",
    input: { args: [] },
    assert: [returns<Context, Result>(undefined)],
  },
  {
    name: "selects Tailscale as the source development exposure provider",
    input: { args: ["serve", "tailscale"] },
    assert: [returns<Context, Result>("tailscale")],
  },
  {
    name: "rejects unsupported development exposure providers",
    input: { args: ["serve", "ngrok"] },
    assert: [hasError<Context, Result>({ message: "unsupported dev serve provider: ngrok" })],
  },
] satisfies readonly OperationCase<"default", Input, Result, Context>[];

const table: OperationTable<undefined, "default", Input, Result, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: (_fixture, input) => parseDevServeProvider(input.args),
  observe: () => ({}),
};

describe("muximo dev command", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
