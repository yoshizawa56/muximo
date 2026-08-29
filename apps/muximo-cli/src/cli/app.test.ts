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
import type { MuximoCliRuntimeOptions } from "./runtime-types.js";

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
type FixtureKey = "environment";

function contains<ContextType>(key: keyof ContextType, value: string) {
  return {
    name: `contains ${String(key)} text: ${value}`,
    check: (context: ContextType) => {
      expect((context as Record<string, unknown>)[key as string]).toContain(value);
    },
  };
}

const defaultRuntime: MuximoCliRuntimeOptions = {
  environmentName: "prod",
  stateRoot: "/workspace/.state",
  muximodInstanceDirectory: "/workspace/.state/prod/muximod",
  muximodHost: "127.0.0.1",
  muximodPort: 4317,
  muximodServePort: 8444,
  schemaMode: "migrate",
  logLevel: "info",
  logFile: "/workspace/.state/prod/muximod/muximod.log",
  allowedOrigins: [],
  codexRemote: "unix://",
  verbose: false,
};

function createFixture(environment: NodeJS.ProcessEnv = {}, runtime: MuximoCliRuntimeOptions = defaultRuntime) {
  const out = new CaptureOutput();
  const err = new CaptureOutput();
  const calls: Fixture["calls"] = [];
  const handlers = {} as CliHandlers;
  for (const key of [
    "run",
    "shell",
    "tmuxNewSession",
    "tmuxManageSession",
    "sessionList",
    "sessionResume",
    "sessionCleanup",
    "doctor",
    "daemon",
    "pair",
    "serve",
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
  const app = createCliApp({ io: { out, err }, cwd: "/workspace", environment, runtime, handlers });
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
      contains<Context>("output", "--env <profile>"),
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
    name: "dispatches the nested session ls alias to the session list handler",
    input: { args: ["session", "ls"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "sessionList",
          input: { global: false, names: false, json: false, all: false },
        },
      ]),
    ],
  },
  {
    name: "dispatches the workspace ls alias to the workspace list handler",
    input: { args: ["workspace", "ls"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "workspaceList",
          input: { json: false },
        },
      ]),
    ],
  },
  {
    name: "dispatches the workspace create alias to the workspace add handler",
    input: { args: ["workspace", "create", "/work/project"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "workspaceAdd",
          input: {
            directory: "/work/project",
            name: undefined,
            nameExplicit: false,
            setupHook: undefined,
            setupHookExplicit: false,
            cleanupHook: undefined,
            cleanupHookExplicit: false,
          },
        },
      ]),
    ],
  },
  {
    name: "dispatches the workspace remove alias to the workspace delete handler",
    input: { args: ["workspace", "remove", "project"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "workspaceDelete",
          input: { selector: "project" },
        },
      ]),
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
    name: "dispatches a name-or-path workspace selector for run",
    input: { args: ["run", "codex", "--workspace", "project"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "run",
          input: {
            backend: "codex",
            name: undefined,
            workspace: "project",
            useWorktree: false,
            worktreeRoot: undefined,
            setupHook: undefined,
            cleanupHook: undefined,
            setupHookExplicit: false,
            cleanupHookExplicit: false,
            backendArgs: [],
          },
        },
      ]),
    ],
  },
  {
    name: "dispatches the top-level list alias to the session list handler",
    input: { args: ["list", "--json"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "sessionList",
          input: { global: false, names: false, json: true, all: false },
        },
      ]),
    ],
  },
  {
    name: "dispatches the top-level ls alias to the session list handler",
    input: { args: ["ls", "--json"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "sessionList",
          input: { global: false, names: false, json: true, all: false },
        },
      ]),
    ],
  },
  {
    name: "dispatches the top-level resume alias to the session resume handler",
    input: { args: ["resume", "review"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "sessionResume",
          input: { global: false, reference: "review", backendArgs: [] },
        },
      ]),
    ],
  },
  {
    name: "dispatches the top-level cleanup alias to the session cleanup handler",
    input: { args: ["cleanup", "review"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "sessionCleanup",
          input: { global: false, force: false, reference: "review" },
        },
      ]),
    ],
  },
  {
    name: "dispatches existing tmux session adoption through the typed handler",
    input: { args: ["tmux", "manage-session", "--name", "desktop"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "tmuxManageSession",
          input: { name: "desktop" },
        },
      ]),
    ],
  },
  {
    name: "rejects unsafe tmux session names before adoption dispatch",
    input: { args: ["tmux", "manage-session", "--name", "desktop/remote"] },
    assert: [
      returns<Context, number>(2),
      contains<Context>("error", "Invalid arguments for muximo tmux manage-session"),
      hasObserved<Context, number>("calls", []),
    ],
  },
  {
    name: "rejects tmux session names longer than the wire limit before creation dispatch",
    input: { args: ["tmux", "new-session", "--name", "a".repeat(65)] },
    assert: [
      returns<Context, number>(2),
      contains<Context>("error", "Invalid arguments for muximo tmux new-session"),
      hasObserved<Context, number>("calls", []),
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
            command: "tailscale",
            localPort: 4317,
            externalPort: 8444,
          },
        },
      ]),
    ],
  },
  {
    name: "dispatches daemon log with its default line limit",
    input: { args: ["daemon", "log"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "daemon",
          input: {
            command: "log",
            foreground: false,
            refreshServers: false,
            lines: 100,
          },
        },
      ]),
    ],
  },
  {
    name: "rejects direct daemon log file selection",
    input: { args: ["daemon", "log", "--log-file", "/tmp/cli.log"] },
    assert: [
      returns<Context, number>(2),
      contains<Context>("error", "unknown option"),
      hasObserved<Context, number>("calls", []),
    ],
  },
  {
    name: "rejects component-specific serve overrides",
    input: { args: ["serve", "tailscale", "--port", "9444"] },
    assert: [
      returns<Context, number>(2),
      contains<Context>("error", "unknown option"),
      hasObserved<Context, number>("calls", []),
    ],
  },
  {
    name: "resolves daemon values from the command environment",
    fixture: "environment",
    input: { args: ["daemon", "start"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "daemon",
          input: {
            command: "start",
            foreground: false,
            refreshServers: false,
          },
        },
      ]),
    ],
  },
  {
    name: "resolves serve values from the command environment",
    fixture: "environment",
    input: { args: ["serve", "tailscale"] },
    assert: [
      returns<Context, number>(7),
      hasObserved<Context, number>("calls", [
        {
          command: "serve",
          input: {
            provider: "tailscale",
            command: "tailscale",
            localPort: 5001,
            externalPort: 9443,
          },
        },
      ]),
    ],
  },
] satisfies readonly OperationCase<FixtureKey, Input, number, Context>[];

const table: OperationTable<AppFixture, FixtureKey, Input, number, Context> = {
  defaultFixture: () => createFixture(),
  fixtures: {
    environment: () =>
      createFixture(
        {
          MUXIMOD_HOST: "0.0.0.0",
          MUXIMOD_PORT: "5001",
          MUXIMO_MUXIMOD_SERVE_PORT: "9443",
          MUXIMO_LOG_LEVEL: "debug",
          MUXIMO_LOG_FILE: "/tmp/muximod.log",
          MUXIMOD_ALLOWED_ORIGINS: "https://configured.example,http://127.0.0.1:5227",
        },
        { ...defaultRuntime, muximodPort: 5001, muximodServePort: 9443 },
      ),
  },
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
