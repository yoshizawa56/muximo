import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  hasNoError,
  hasObserved,
  runScenarioTable,
  type Assertion,
  type FixtureHandle,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { createAgentDatabase, DrizzleWorkspaceRepository } from "@muximo/infrastructure";
import { MuximoCommand } from "./muximo-command.js";

type WorkspaceStep = {
  args: string[];
  expected: "success" | "error";
  errorIncludes?: string;
};

type Outcome =
  | { ok: true; value: number }
  | { ok: false; error: unknown };

type WorkspaceFixture = ReturnType<typeof createFixture> & {
  command: MuximoCommand;
  output: Writable & { value: () => string };
  outcomes: Outcome[];
  steps: readonly WorkspaceStep[];
  closed: boolean;
};

type WorkspaceContext = {
  steps: readonly WorkspaceStep[];
  outcomes: readonly Outcome[];
  workspaceCount: number;
  workspaceName: string | null;
  workspaceRootPath: string | null;
  fixtureWorkspacePath: string;
  setupHook: string | null;
  copyPatterns: readonly string[];
  output: string;
  directoryEntries: readonly string[];
  readme: string;
};

const stepOutcomesMatch: Assertion<WorkspaceContext, void> = {
  name: "all command steps have their expected outcomes",
  check: (ctx) => {
    expect(ctx.outcomes).toHaveLength(ctx.steps.length);
    for (const [index, step] of ctx.steps.entries()) {
      const outcome = ctx.outcomes[index]!;
      if (step.expected === "success") {
        expect(outcome, `step ${index + 1} should succeed`).toMatchObject({ ok: true });
      } else {
        expect(outcome, `step ${index + 1} should fail`).toMatchObject({ ok: false });
        if (step.errorIncludes) expect(errorText(outcome)).toContain(step.errorIncludes);
      }
    }
  },
};

const outputContains = (...texts: string[]): Assertion<WorkspaceContext, void> => ({
  name: `CLI output contains ${texts.join(", ")}`,
  check: (ctx) => {
    for (const text of texts) expect(ctx.output).toContain(text);
  },
});

const workspaceDirectoryRemains = (): Assertion<WorkspaceContext, void> => ({
  name: "workspace directory remains intact",
  check: (ctx) => {
    expect(ctx.directoryEntries).toContain("hooks");
    expect(ctx.readme).toBe("workspace fixture\n");
  },
});

const canonicalizesGitRoot: Assertion<WorkspaceContext, void> = {
  name: "workspace registration uses the repository root",
  check: (ctx) => expect(ctx.workspaceRootPath).toBe(ctx.fixtureWorkspacePath),
};

type WorkspaceFixtureKey = "default" | "git-subdirectory";

const scenarios = [
  {
    name: "adds updates lists and deletes only the workspace registration",
    steps: [
      { args: ["workspace", "add", ".", "--name", "primary", "--copy-pattern", ".env"], expected: "success" },
      { args: ["list", "--json"], expected: "success" },
      { args: ["workspace", "update", "primary", "--name", "renamed", "--clear-copy-patterns"], expected: "success" },
      { args: ["workspace", "list", "--json"], expected: "success" },
      { args: ["workspace", "delete", "renamed"], expected: "success" },
      { args: ["workspace", "list", "--json"], expected: "success" },
    ],
    assert: [
      hasNoError<WorkspaceContext, void>(),
      stepOutcomesMatch,
      hasObserved<WorkspaceContext, void>("workspaceCount", 0),
      outputContains("workspace 'primary' added", "workspace 'renamed' updated", "workspace 'renamed' unregistered; directory was not deleted"),
      workspaceDirectoryRemains(),
    ],
  },
  {
    name: "validates hooks and preserves configured workspace metadata",
    steps: [
      { args: ["workspace", "add", ".", "--setup-hook", "hooks/setup", "--copy-pattern", ".env", "--copy-pattern", "config/**/*.local.json"], expected: "success" },
      { args: ["workspace", "update", "workspace", "--no-setup-hook", "--add-copy-pattern", "tmp/local.json"], expected: "success" },
      { args: ["workspace", "list", "--json"], expected: "success" },
    ],
    assert: [
      hasNoError<WorkspaceContext, void>(),
      stepOutcomesMatch,
      hasObserved<WorkspaceContext, void>("workspaceCount", 1),
      hasObserved<WorkspaceContext, void>("workspaceName", "workspace"),
      hasObserved<WorkspaceContext, void>("setupHook", null),
      hasObserved<WorkspaceContext, void>("copyPatterns", [".env", "config/**/*.local.json", "tmp/local.json"]),
      workspaceDirectoryRemains(),
    ],
  },
  {
    name: "rejects an invalid hook without creating a partial registration",
    steps: [
      { args: ["workspace", "add", ".", "--setup-hook", "hooks/missing"], expected: "error", errorIncludes: "workspace hook does not exist" },
      { args: ["workspace", "list", "--json"], expected: "success" },
    ],
    assert: [
      hasNoError<WorkspaceContext, void>(),
      stepOutcomesMatch,
      hasObserved<WorkspaceContext, void>("workspaceCount", 0),
      workspaceDirectoryRemains(),
    ],
  },
  {
    name: "exposes session list under the new namespace and the legacy alias",
    steps: [
      { args: ["session", "list", "--global", "--json"], expected: "success" },
      { args: ["list", "--global", "--json"], expected: "success" },
    ],
    assert: [
      hasNoError<WorkspaceContext, void>(),
      stepOutcomesMatch,
      hasObserved<WorkspaceContext, void>("workspaceCount", 0),
      workspaceDirectoryRemains(),
    ],
  },
  {
    name: "canonicalizes a git subdirectory to the repository root",
    fixture: "git-subdirectory",
    steps: [
      { args: ["workspace", "add", ".", "--name", "git-root"], expected: "success" },
      { args: ["list", "--global", "--json"], expected: "success" },
    ],
    assert: [
      hasNoError<WorkspaceContext, void>(),
      stepOutcomesMatch,
      hasObserved<WorkspaceContext, void>("workspaceCount", 1),
      hasObserved<WorkspaceContext, void>("workspaceName", "git-root"),
      outputContains("workspace 'git-root' added"),
      canonicalizesGitRoot,
      workspaceDirectoryRemains(),
    ],
  },
] satisfies readonly ScenarioCase<WorkspaceFixtureKey, WorkspaceStep, void, WorkspaceContext>[];

const workspaceFixtures: Readonly<Record<WorkspaceFixtureKey, () => FixtureHandle<WorkspaceFixture>>> = {
  default: () => createWorkspaceFixture("plain"),
  "git-subdirectory": () => createWorkspaceFixture("git-subdirectory"),
};

const table: ScenarioTable<WorkspaceFixture, WorkspaceFixtureKey, WorkspaceStep, void, WorkspaceContext> = {
  defaultFixture: workspaceFixtures.default,
  fixtures: workspaceFixtures,
  cases: scenarios,
  execute: async (fixture, steps) => {
    fixture.steps = steps;
    try {
      for (const step of steps) {
        try {
          fixture.outcomes.push({ ok: true, value: await fixture.command.execute(step.args) });
        } catch (error) {
          fixture.outcomes.push({ ok: false, error });
        }
      }
    } finally {
      fixture.command.close();
      fixture.closed = true;
    }
  },
  observe: async (fixture) => {
    const database = createAgentDatabase(fixture.database);
    let workspaces;
    try {
      workspaces = await new DrizzleWorkspaceRepository(database.db).list();
    } finally {
      database.close();
    }
    const workspace = workspaces[0];
    return {
      steps: fixture.steps,
      outcomes: [...fixture.outcomes],
      workspaceCount: workspaces.length,
      workspaceName: workspace?.name ?? null,
      workspaceRootPath: workspace?.rootPath ?? null,
      fixtureWorkspacePath: realpathSync(fixture.workspace),
      setupHook: workspace?.setupScriptPath ?? null,
      copyPatterns: workspace?.worktreeCopyPatterns ?? [],
      output: fixture.output.value(),
      directoryEntries: readdirSync(fixture.workspace),
      readme: readFileSync(join(fixture.workspace, "README"), "utf8"),
    };
  },
};

describe("workspace and session CLI commands", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

function createWorkspaceFixture(kind: "plain" | "git-subdirectory"): FixtureHandle<WorkspaceFixture> {
  const fixture = createFixture(kind);
  const output = captureOutput();
  const command = new MuximoCommand({
    cwd: fixture.cwd,
    databaseFile: fixture.database,
    env: fixture.env,
    io: { out: output, err: output },
  });
  const value: WorkspaceFixture = { ...fixture, command, output, outcomes: [], steps: [], closed: false };
  return {
    fixture: value,
    cleanup: () => {
      if (!value.closed) {
        value.command.close();
        value.closed = true;
      }
      rmSync(value.root, { recursive: true, force: true });
    },
  };
}

function createFixture(kind: "plain" | "git-subdirectory") {
  const root = mkdtempSync(join(tmpdir(), "muximo-workspace-cli-test-"));
  const workspace = join(root, "workspace");
  const hooks = join(workspace, "hooks");
  const database = join(root, "muximod.sqlite");
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(workspace, "README"), "workspace fixture\n");
  writeExecutable(join(hooks, "setup"), "#!/bin/sh\nexit 0\n");
  if (kind === "git-subdirectory") {
    execFileSync("git", ["init", "-q", workspace]);
    mkdirSync(join(workspace, "nested"), { recursive: true });
  }
  return {
    root,
    workspace,
    cwd: kind === "git-subdirectory" ? join(workspace, "nested") : workspace,
    database,
    env: {
      ...process.env,
      MUXIMOD_DB_FILE: database,
      MUXIMO_ASSUME_YES: "1",
    },
  };
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function captureOutput(): Writable & { value: () => string } {
  let value = "";
  const output = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    },
  }) as Writable & { value: () => string };
  output.value = () => value;
  return output;
}

function errorText(outcome: Outcome): string {
  return outcome.ok ? "" : outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
}
