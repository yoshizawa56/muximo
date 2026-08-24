import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { TERMINAL_FONT_FAMILY, TERMINAL_SYMBOL_FONT_FAMILY } from "./-terminal-font";

type Context = {};
type Result = { family: string; startsWithSymbols: boolean };

const cases = [
  {
    name: "prefers the bundled Nerd Font symbols before local monospace fonts",
    input: {},
    assert: [
      returns<Context, Result>({
        family:
          '"Symbols Nerd Font Mono", "SFMono-Regular", "Cascadia Code", "Roboto Mono", Menlo, ui-monospace, monospace',
        startsWithSymbols: true,
      }),
    ],
  },
] satisfies readonly OperationCase<"default", {}, Result, Context>[];

const table: OperationTable<undefined, "default", {}, Result, Context> = {
  defaultFixture: noFixture(),
  cases,
  execute: () => ({
    family: TERMINAL_FONT_FAMILY,
    startsWithSymbols: TERMINAL_FONT_FAMILY.startsWith(`"${TERMINAL_SYMBOL_FONT_FAMILY}"`),
  }),
  observe: () => ({}),
};

describe("terminal font configuration", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
