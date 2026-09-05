import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { defaultMuximoConfig, type MuximoConfig } from "@muximo/instance-contract";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { ConfigPrompt, ConfigPromptChoice } from "./adapters/inquirer-config-prompt.js";
import { runMuximoConfigInit } from "./config-init.js";

class CaptureOutput extends Writable {
  public value = "";

  public _write(chunk: Buffer | string, _encoding: string, callback: (error?: Error) => void): void {
    this.value += chunk.toString();
    callback();
  }
}

type PromptAnswer =
  | { kind: "checkbox"; value: readonly string[] }
  | { kind: "select"; value: string }
  | { kind: "input"; value: string }
  | { kind: "search"; value: string };

class QueuePrompt implements ConfigPrompt {
  public readonly calls: string[] = [];
  private index = 0;

  public constructor(private readonly answers: readonly PromptAnswer[]) {}

  public checkbox(options: { message: string; choices: readonly ConfigPromptChoice[] }): Promise<readonly string[]> {
    this.calls.push(`checkbox:${options.message}`);
    const answer = this.take("checkbox");
    return Promise.resolve(answer.value);
  }

  public select(options: {
    message: string;
    choices: readonly ConfigPromptChoice[];
    defaultValue?: string;
  }): Promise<string> {
    this.calls.push(`select:${options.message}`);
    const answer = this.take("select");
    return Promise.resolve(answer.value);
  }

  public input(options: {
    message: string;
    defaultValue?: string;
    validate?: (value: string) => string | true | undefined;
  }): Promise<string> {
    this.calls.push(`input:${options.message}`);
    const answer = this.take("input");
    return Promise.resolve(answer.value);
  }

  public search(options: {
    message: string;
    initialValue?: string;
    source: (term: string | undefined) => readonly ConfigPromptChoice[] | Promise<readonly ConfigPromptChoice[]>;
    validate?: (value: string) => string | true | undefined;
  }): Promise<string> {
    this.calls.push(`search:${options.message}`);
    const answer = this.take("search");
    return Promise.resolve(answer.value);
  }

  private take(kind: "checkbox"): Extract<PromptAnswer, { kind: "checkbox" }>;
  private take(kind: "select"): Extract<PromptAnswer, { kind: "select" }>;
  private take(kind: "input"): Extract<PromptAnswer, { kind: "input" }>;
  private take(kind: "search"): Extract<PromptAnswer, { kind: "search" }>;
  private take(kind: PromptAnswer["kind"]): PromptAnswer {
    const answer = this.answers[this.index];
    this.index += 1;
    if (answer?.kind !== kind) {
      throw new Error(`expected ${kind} prompt answer, received ${answer?.kind ?? "nothing"}`);
    }
    return answer;
  }
}

type FixtureKey = "detected" | "manual";
type InitFixture = {
  environment: NodeJS.ProcessEnv;
  cwd: string;
};
type InitInput = { answers: readonly PromptAnswer[] };
type InitResult = { config: MuximoConfig | null; calls: readonly string[]; output: string };
type InitContext = {
  enabled: string;
  defaultAgent: string | null;
  tailscaleEnabled: boolean;
  tailscalePort: number;
  workspaceRoots: readonly string[];
  calls: readonly string[];
  output: string;
  reportedInvalidPort: boolean;
  reportedInvalidExecutable: boolean;
};

const cases = [
  {
    name: "accepts no selected agents and configures a tmux-only instance without agent prompts",
    fixture: "detected" as const,
    input: {
      answers: [
        { kind: "checkbox", value: [] },
        { kind: "select", value: "disabled" },
        { kind: "select", value: "recommended" },
        { kind: "select", value: "save" },
      ],
    },
    assert: [
      hasObserved<InitContext, InitResult>("enabled", ""),
      hasObserved<InitContext, InitResult>("defaultAgent", null),
      hasObserved<InitContext, InitResult>("tailscaleEnabled", false),
      hasObserved<InitContext, InitResult>("calls", [
        "checkbox:Select agents to enable (optional; select none to disable all agent backends)",
        "select:How should Tailscale Serve be used?",
        "select:How should the remaining settings be configured?",
        "select:What would you like to do?",
      ]),
    ],
  },
  {
    name: "auto-configures the only selected agent from a detected executable",
    fixture: "detected" as const,
    input: {
      answers: [
        { kind: "checkbox", value: ["codex"] },
        { kind: "select", value: "disabled" },
        { kind: "select", value: "recommended" },
        { kind: "select", value: "save" },
      ],
    },
    assert: [
      hasObserved<InitContext, InitResult>("enabled", "codex"),
      hasObserved<InitContext, InitResult>("defaultAgent", "codex"),
      hasObserved<InitContext, InitResult>("calls", [
        "checkbox:Select agents to enable (optional; select none to disable all agent backends)",
        "select:How should Tailscale Serve be used?",
        "select:How should the remaining settings be configured?",
        "select:What would you like to do?",
      ]),
    ],
  },
  {
    name: "customizes only the selected Tailscale field and retries invalid input",
    fixture: "detected" as const,
    input: {
      answers: [
        { kind: "checkbox", value: ["codex", "claude"] },
        { kind: "select", value: "claude" },
        { kind: "select", value: "custom" },
        { kind: "checkbox", value: ["serve.tailscale.externalPort"] },
        { kind: "input", value: "0" },
        { kind: "input", value: "8443" },
        { kind: "select", value: "recommended" },
        { kind: "select", value: "save" },
      ],
    },
    assert: [
      hasObserved<InitContext, InitResult>("enabled", "codex,claude"),
      hasObserved<InitContext, InitResult>("defaultAgent", "claude"),
      hasObserved<InitContext, InitResult>("tailscaleEnabled", true),
      hasObserved<InitContext, InitResult>("tailscalePort", 8443),
      hasObserved<InitContext, InitResult>("calls", [
        "checkbox:Select agents to enable (optional; select none to disable all agent backends)",
        "select:Select the default agent",
        "select:How should Tailscale Serve be used?",
        "checkbox:Which Tailscale settings should be customized?",
        "input:External port used by the Tailscale Serve route. (an integer from 1 to 65535)",
        "input:External port used by the Tailscale Serve route. (an integer from 1 to 65535)",
        "select:How should the remaining settings be configured?",
        "select:What would you like to do?",
      ]),
      hasObserved<InitContext, InitResult>("reportedInvalidPort", true),
    ],
  },
  {
    name: "customizes one workspace area without asking unrelated settings",
    fixture: "detected" as const,
    input: {
      answers: [
        { kind: "checkbox", value: [] },
        { kind: "select", value: "disabled" },
        { kind: "select", value: "custom" },
        { kind: "checkbox", value: ["workspace"] },
        { kind: "input", value: "~/work,~/other" },
        { kind: "select", value: "save" },
      ],
    },
    assert: [
      hasObserved<InitContext, InitResult>("workspaceRoots", ["~/work", "~/other"]),
      hasObserved<InitContext, InitResult>("calls", [
        "checkbox:Select agents to enable (optional; select none to disable all agent backends)",
        "select:How should Tailscale Serve be used?",
        "select:How should the remaining settings be configured?",
        "checkbox:Which areas should be customized?",
        "input:Directories searched for available workspaces. (comma-separated directories or a JSON array of directories)",
        "select:What would you like to do?",
      ]),
    ],
  },
  {
    name: "asks for a selected agent executable only when discovery fails and retries invalid paths",
    fixture: "manual" as const,
    input: {
      answers: [
        { kind: "checkbox", value: ["opencode"] },
        { kind: "search", value: "/missing/opencode" },
        { kind: "search", value: "manual/opencode" },
        { kind: "select", value: "disabled" },
        { kind: "select", value: "recommended" },
        { kind: "select", value: "save" },
      ],
    },
    assert: [
      hasObserved<InitContext, InitResult>("enabled", "opencode"),
      hasObserved<InitContext, InitResult>("defaultAgent", "opencode"),
      hasObserved<InitContext, InitResult>("calls", [
        "checkbox:Select agents to enable (optional; select none to disable all agent backends)",
        "search:Enter the opencode executable path or command",
        "search:Enter the opencode executable path or command",
        "select:How should Tailscale Serve be used?",
        "select:How should the remaining settings be configured?",
        "select:What would you like to do?",
      ]),
      hasObserved<InitContext, InitResult>("reportedInvalidExecutable", true),
    ],
  },
] satisfies readonly OperationCase<FixtureKey, InitInput, InitResult, InitContext>[];

const table: OperationTable<InitFixture, FixtureKey, InitInput, InitResult, InitContext> = {
  defaultFixture: () => createFixture("detected"),
  fixtures: {
    detected: () => createFixture("detected"),
    manual: () => createFixture("manual"),
  },
  cases,
  execute: async (fixture, input) => {
    const prompt = new QueuePrompt(input.answers);
    const output = new CaptureOutput();
    const config = await runMuximoConfigInit(defaultMuximoConfig(), {
      prompt,
      output,
      cwd: fixture.cwd,
      environment: fixture.environment,
      platform: "linux",
    });
    return { config, calls: prompt.calls, output: output.value };
  },
  observe: (_fixture, result) =>
    result.ok
      ? {
          enabled: result.value.config?.agents.enabled.join(",") ?? "",
          defaultAgent: result.value.config?.agents.default ?? null,
          tailscaleEnabled: result.value.config?.serve.tailscale.enabled ?? false,
          tailscalePort: result.value.config?.serve.tailscale.externalPort ?? 0,
          workspaceRoots: result.value.config?.workspace.roots ?? [],
          calls: result.value.calls,
          output: result.value.output,
          reportedInvalidPort: result.value.output.includes("Invalid value for serve.tailscale.externalPort"),
          reportedInvalidExecutable: result.value.output.includes("Invalid value for agents.executables.opencode"),
        }
      : {
          enabled: "",
          defaultAgent: null,
          tailscaleEnabled: false,
          tailscalePort: 0,
          workspaceRoots: [],
          calls: [],
          output: "",
          reportedInvalidPort: false,
          reportedInvalidExecutable: false,
        },
};

describe("muximo config initialization", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFixture(kind: FixtureKey): { fixture: InitFixture; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), `muximo-config-init-${kind}-`));
  const binDirectory = join(root, "bin");
  const manualDirectory = join(root, "manual");
  mkdirSync(binDirectory, { recursive: true });
  mkdirSync(manualDirectory, { recursive: true });
  for (const name of kind === "detected" ? ["codex", "claude", "tailscale"] : ["tailscale"]) {
    writeExecutable(join(binDirectory, name));
  }
  writeExecutable(join(manualDirectory, "opencode"));
  return {
    fixture: {
      environment: { HOME: root, PATH: binDirectory },
      cwd: root,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeExecutable(filePath: string): void {
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(filePath, 0o700);
}
