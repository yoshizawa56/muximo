import { type OperationCase, type OperationTable, runOperationTable, type TestRegistrar } from "@muximo/test-support";
import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { defineOptions, registerOptions } from "../options/index.js";
import { generateZshCompletion } from "./zsh.js";

const rootOptions = defineOptions({
  key: "verbose",
  flags: ["-v, --verbose"],
  description: "Show diagnostics.",
  exposure: "cli",
});

const serveOptions = defineOptions(
  {
    key: "port",
    flags: ["--port <port>"],
    description: "Port.",
    exposure: "cli",
    completion: { kind: "integer" },
  },
  {
    key: "logLevel",
    flags: ["--log-level <level>"],
    description: "Log level.",
    exposure: "cli",
    completion: { kind: "choices", values: ["error", "warn", "info", "debug"] },
  },
);

type Fixture = { completion: string };
type Input = { command: "root" | "serve" };
type Context = Fixture;

const createFixture = () => {
  const program = new Command().name("muximo");
  registerOptions(program, rootOptions);
  const serve = program.command("serve");
  registerOptions(serve, serveOptions);
  return { fixture: { completion: generateZshCompletion(program) } };
};

const containsText = (value: string) => ({
  name: `contains ${value}`,
  check: (context: Context) => {
    expect(context.completion).toContain(value);
  },
});

const cases = [
  {
    name: "generates a root completion function with global options and commands",
    input: { command: "root" },
    assert: [
      containsText("#compdef muximo"),
      containsText("compdef _muximo muximo"),
      containsText("-v[Show\\ diagnostics.]"),
      containsText("serve"),
    ],
  },
  {
    name: "generates a child completion function with inherited and local options",
    input: { command: "serve" },
    assert: [
      containsText("_muximo_serve()"),
      containsText("--verbose[Show\\ diagnostics.]"),
      containsText("--port[Port.]:port:"),
      containsText("--log-level[Log\\ level.]:level:(error warn info debug)"),
    ],
  },
] satisfies readonly OperationCase<"default", Input, string, Context>[];

const table: OperationTable<Fixture, "default", Input, string, Context> = {
  defaultFixture: createFixture,
  cases,
  execute: (fixture) => fixture.completion,
  observe: (fixture) => fixture,
};

describe("zsh completion generation", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
});
