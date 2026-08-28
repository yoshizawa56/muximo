import { Writable } from "node:stream";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { runMuximoCli } from "./entrypoint.js";

class CaptureOutput extends Writable {
  public value = "";

  public _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error) => void): void {
    this.value += chunk.toString();
    callback();
  }
}

type Fixture = { out: CaptureOutput; err: CaptureOutput };
type Input = { args: readonly string[]; includeDevelopmentCommands: boolean };
type Context = Fixture & { output: string; error: string };

function createFixture() {
  return { fixture: { out: new CaptureOutput(), err: new CaptureOutput() } };
}

function containsOutput(key: "output" | "error", value: string) {
  return {
    name: `contains ${key} text: ${value}`,
    check: (context: Context) => {
      expect(context[key]).toContain(value);
    },
  };
}

function excludesOutput(key: "output" | "error", value: string) {
  return {
    name: `excludes ${key} text: ${value}`,
    check: (context: Context) => {
      expect(context[key]).not.toContain(value);
    },
  };
}

const cases = [
  {
    name: "prints root help without constructing the infrastructure composition",
    input: { args: [], includeDevelopmentCommands: false },
    assert: [
      returns<Context, number>(2),
      containsOutput("output", "Usage: muximo"),
      containsOutput("output", "MUXIMOD_INSTANCE_DIR"),
      excludesOutput("output", "  dev "),
    ],
  },
  {
    name: "includes development commands in the source development entrypoint",
    input: { args: [], includeDevelopmentCommands: true },
    assert: [returns<Context, number>(2), containsOutput("output", "  dev ")],
  },
  {
    name: "generates zsh completion at the process boundary",
    input: { args: ["completion", "zsh"], includeDevelopmentCommands: false },
    assert: [
      returns<Context, number>(0),
      containsOutput("output", "#compdef muximo"),
      hasObserved<Context, number>("error", ""),
    ],
  },
  {
    name: "prints command help without opening the database",
    input: { args: ["serve", "tailscale", "--help"], includeDevelopmentCommands: false },
    assert: [
      returns<Context, number>(0),
      containsOutput("output", "Usage: muximo serve tailscale"),
      containsOutput("output", "Environment: MUXIMO_SERVE_PORT"),
      hasObserved<Context, number>("error", ""),
    ],
  },
] satisfies readonly OperationCase<"default", Input, number, Context>[];

const table: OperationTable<Fixture, "default", Input, number, Context> = {
  defaultFixture: createFixture,
  cases,
  execute: (fixture, input) =>
    runMuximoCli(input.args, {
      includeDevelopmentCommands: input.includeDevelopmentCommands,
      env: {},
      out: fixture.out,
      err: fixture.err,
    }),
  observe: (fixture) => ({
    ...fixture,
    output: fixture.out.value,
    error: fixture.err.value,
  }),
};

describe("muximo process entrypoint", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
});
