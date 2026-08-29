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
import type { CliBuildMode } from "./cli/build-mode.js";
import { runMuximoCli } from "./entrypoint.js";

class CaptureOutput extends Writable {
  public value = "";

  public _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error) => void): void {
    this.value += chunk.toString();
    callback();
  }
}

type Fixture = { out: CaptureOutput; err: CaptureOutput };
type Input = { args: readonly string[]; buildMode?: CliBuildMode };
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
    input: { args: [] },
    assert: [
      returns<Context, number>(2),
      containsOutput("output", "Usage: muximo"),
      containsOutput("output", "MUXIMO_ENV"),
      excludesOutput("output", "  dev "),
    ],
  },
  {
    name: "does not expose a development supervisor command",
    input: { args: [] },
    assert: [returns<Context, number>(2), excludesOutput("output", "  dev ")],
  },
  {
    name: "omits development-only profile options from production help",
    input: { args: [], buildMode: "production" },
    assert: [
      returns<Context, number>(2),
      excludesOutput("output", "--env <profile>"),
      excludesOutput("output", "MUXIMO_ENV"),
    ],
  },
  {
    name: "rejects development-only profile options in production",
    input: { args: ["--env", "local", "daemon", "status"], buildMode: "production" },
    assert: [returns<Context, number>(1), containsOutput("error", "--env is not available in production builds")],
  },
  {
    name: "generates zsh completion at the process boundary",
    input: { args: ["completion", "zsh"] },
    assert: [
      returns<Context, number>(0),
      containsOutput("output", "#compdef muximo"),
      hasObserved<Context, number>("error", ""),
    ],
  },
  {
    name: "omits development-only profile options from production completion",
    input: { args: ["completion", "zsh"], buildMode: "production" },
    assert: [returns<Context, number>(0), excludesOutput("output", "--env"), excludesOutput("output", "MUXIMO_ENV")],
  },
  {
    name: "prints command help without opening the database",
    input: { args: ["serve", "tailscale", "--help"] },
    assert: [
      returns<Context, number>(0),
      containsOutput("output", "Usage: muximo serve tailscale"),
      hasObserved<Context, number>("error", ""),
    ],
  },
] satisfies readonly OperationCase<"default", Input, number, Context>[];

const table: OperationTable<Fixture, "default", Input, number, Context> = {
  defaultFixture: createFixture,
  cases,
  execute: (fixture, input) =>
    runMuximoCli(input.args, {
      buildMode: input.buildMode,
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
