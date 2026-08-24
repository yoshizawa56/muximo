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
import { createCliApp } from "./app.js";
import type { CliHandlers } from "./commands/types.js";

class CaptureOutput extends Writable {
  public value = "";
  public _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error) => void): void {
    this.value += chunk.toString();
    callback();
  }
}

type Fixture = {
  out: CaptureOutput;
  err: CaptureOutput;
  calls: Array<{ command: string; input: unknown }>;
};

type Input = { args: readonly string[] };
type Context = Fixture & { output: string; error: string };

function contains<ContextType>(key: keyof ContextType, value: string) {
  return {
    name: `contains ${String(key)} text`,
    check: (context: ContextType) => {
      expect((context as Record<string, unknown>)[key as string]).toContain(value);
    },
  };
}

function createFixture() {
  const out = new CaptureOutput();
  const err = new CaptureOutput();
  const calls: Fixture["calls"] = [];
  const handlers = {} as CliHandlers;
  for (const key of [
    "run",
    "shell",
    "tmuxNewSession",
    "sessionList",
    "sessionResume",
    "sessionCleanup",
    "doctor",
    "daemon",
    "pair",
    "serve",
    "dev",
    "workspaceList",
    "workspaceAdd",
    "workspaceUpdate",
    "workspaceDelete",
  ] as const) {
    handlers[key] = async (input: never) => {
      calls.push({ command: key, input });
      return 7;
    };
  }
  const app = createCliApp({ io: { out, err }, cwd: "/workspace", handlers });
  return { fixture: { out, err, calls, app } };
}

type AppFixture = ReturnType<typeof createFixture>["fixture"];

const cases = [
  {
    name: "prints Commander root help for empty arguments",
    input: { args: [] },
    assert: [
      returns<Context, number>(2),
      contains<Context>("output", "Usage: muximo"),
      hasObserved<Context, number>("calls", []),
    ],
  },
  {
    name: "prints help without invoking a handler",
    input: { args: ["--help"] },
    assert: [
      returns<Context, number>(0),
      contains<Context>("output", "Commands:"),
      hasObserved<Context, number>("calls", []),
    ],
  },
  {
    name: "reports an unknown command as a concise argument error",
    input: { args: ["unknown"] },
    assert: [
      returns<Context, number>(2),
      contains<Context>("error", "Invalid arguments for muximo unknown"),
      hasObserved<Context, number>("calls", []),
    ],
  },
  {
    name: "validates nested session list options before dispatch",
    input: { args: ["session", "list", "--names", "--json"] },
    assert: [
      returns<Context, number>(2),
      contains<Context>("error", "--names and --json cannot be combined"),
      hasObserved<Context, number>("calls", []),
    ],
  },
  {
    name: "dispatches typed run input while preserving opaque backend arguments",
    input: { args: ["run", "codex", "--profile", "review"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "run",
          input: {
            backend: "codex",
            name: undefined,
            useWorktree: false,
            worktreeRoot: undefined,
            setupHook: undefined,
            cleanupHook: undefined,
            setupHookExplicit: false,
            cleanupHookExplicit: false,
            backendArgs: ["--profile", "review"],
          },
        },
      ]),
    ],
  },
  {
    name: "dispatches exact serve defaults through the typed handler",
    input: { args: ["serve", "tailscale"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "serve",
          input: {
            provider: "tailscale",
            muximodHost: "127.0.0.1",
            muximodPort: 4317,
            externalPort: 8444,
            pidFile: undefined,
            logLevel: "info",
            logFile: undefined,
          },
        },
      ]),
    ],
  },
  {
    name: "dispatches explicit browser origins without wildcard expansion",
    input: { args: ["serve", "tailscale", "--allowed-origin", "https://web.example", "http://127.0.0.1:5227"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "serve",
          input: {
            provider: "tailscale",
            muximodHost: "127.0.0.1",
            muximodPort: 4317,
            externalPort: 8444,
            pidFile: undefined,
            logLevel: "info",
            logFile: undefined,
            allowedOrigins: ["https://web.example", "http://127.0.0.1:5227"],
          },
        },
      ]),
    ],
  },
] satisfies readonly OperationCase<"default", Input, number, Context>[];

const table: OperationTable<AppFixture, "default", Input, number, Context> = {
  defaultFixture: createFixture,
  cases,
  execute: (fixture, input) => fixture.app.execute(input.args),
  observe: (fixture) => ({
    ...fixture,
    output: fixture.out.value,
    error: fixture.err.value,
  }),
};

describe("muximo CLI application boundary", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, table);
});
