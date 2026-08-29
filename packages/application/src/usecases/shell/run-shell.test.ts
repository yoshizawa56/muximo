import { Workspace, WorkspaceId } from "@muximo/domain";
import {
  hasEvents,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { ShellProcessInput } from "../../ports/shell.js";
import { RunShell, type RunShellResult } from "./run-shell.js";

type ShellFixture = {
  workspaceRoot: string;
  worktreePath: string;
  events: string[];
  shellInputs: ShellProcessInput[];
  exitCode: number;
  service: RunShell;
};

type ShellResult = {
  process: RunShellResult["process"];
  events: readonly string[];
  shell: ShellProcessInput | undefined;
};

type ShellFixtureKey = "success" | "failure";
type Input = { shell?: string };

const cases = [
  {
    name: "runs shell setup and cleanup in order before restoring pane metadata",
    fixture: "success",
    input: {},
    assert: [
      hasObserved<ShellResult, ShellResult>("process", { code: 0, interrupted: false }),
      hasEvents<ShellResult, ShellResult>("events", [
        "mark-shell",
        "resolve-workspace",
        "create-worktree",
        "resolve-setup",
        "resolve-cleanup",
        "copy-files",
        "setup-hook",
        "shell",
        "cleanup-hook",
        "remove-worktree",
        "restore-shell",
      ]),
    ],
  },
  {
    name: "cleans up a worktree even when the interactive shell exits nonzero",
    fixture: "failure",
    input: {},
    assert: [
      hasObserved<ShellResult, ShellResult>("process", { code: 3, interrupted: false }),
      hasEvents<ShellResult, ShellResult>("events", [
        "mark-shell",
        "resolve-workspace",
        "create-worktree",
        "resolve-setup",
        "resolve-cleanup",
        "copy-files",
        "setup-hook",
        "shell",
        "cleanup-hook",
        "remove-worktree",
        "restore-shell",
      ]),
    ],
  },
  {
    name: "uses the host-selected shell when no shell override is provided",
    fixture: "success",
    input: {},
    assert: [
      hasObserved<ShellResult, ShellResult>("shell", {
        executable: "/bin/zsh",
        args: ["-l", "-i"],
        cwd: "/workspace/.worktrees/review",
        interactive: true,
      }),
    ],
  },
  {
    name: "uses an explicit shell override instead of the host-selected shell",
    fixture: "success",
    input: { shell: "/bin/bash" },
    assert: [
      hasObserved<ShellResult, ShellResult>("shell", {
        executable: "/bin/bash",
        args: ["-l", "-i"],
        cwd: "/workspace/.worktrees/review",
        interactive: true,
      }),
    ],
  },
] satisfies readonly OperationCase<ShellFixtureKey, Input, ShellResult, ShellResult>[];

const table: OperationTable<ShellFixture, ShellFixtureKey, Input, ShellResult, ShellResult> = {
  defaultFixture: () => createShellFixture(0),
  fixtures: {
    success: () => createShellFixture(0),
    failure: () => createShellFixture(3),
  },
  cases,
  execute: async (fixture, input) => {
    const result = await fixture.service.execute({
      shell: input.shell,
      command: [],
      exitAfterCommand: false,
      worktree: true,
      worktreeName: "review",
    });
    return {
      process: result.process,
      events: [...fixture.events],
      shell: fixture.shellInputs.find((shellInput) => shellInput.interactive),
    };
  },
  observe: (fixture, result) => ({
    process: result.ok ? result.value.process : { code: -1, interrupted: false },
    events: [...fixture.events],
    shell: fixture.shellInputs.find((shellInput) => shellInput.interactive),
  }),
};

function createShellFixture(
  exitCode: number,
  registerCleanup?: (cleanup: () => void) => void,
): { fixture: ShellFixture } {
  const workspaceRoot = "/workspace";
  const worktreePath = "/workspace/.worktrees/review";
  const workspace = Workspace.create({
    id: WorkspaceId.create("workspace-id"),
    rootPath: workspaceRoot,
    name: "workspace",
    isGit: true,
    setupScriptPath: "setup-hook",
    cleanupScriptPath: "cleanup-hook",
    worktreeCopyPatterns: [".env"],
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  });
  const events: string[] = [];
  const record = (event: string) => events.push(event);
  const fixture: ShellFixture = {
    workspaceRoot,
    worktreePath,
    events,
    shellInputs: [],
    exitCode,
    service: undefined as unknown as RunShell,
  };
  fixture.service = new RunShell({
    cwd: workspaceRoot,
    paneName: "shell-pane",
    defaultShell: "/bin/zsh",
    workspace: {
      resolveCurrent: async () => {
        record("resolve-workspace");
        return workspace;
      },
    },
    sessions: {
      findWorktreePath: async () => workspaceRoot,
    },
    process: {
      run: async (input) => {
        fixture.shellInputs.push({ ...input, args: [...input.args] });
        record("shell");
        return { code: exitCode, interrupted: false };
      },
    },
    worktrees: {
      create: async () => {
        record("create-worktree");
        return {
          worktreeRoot: "/workspace/.worktrees",
          worktreePath,
          branch: "muximo/review",
          baseCommit: "base-commit",
        };
      },
      copyFiles: async () => {
        record("copy-files");
        return true;
      },
      remove: async () => {
        record("remove-worktree");
      },
    },
    hooks: {
      resolveHook: async (value: string) => {
        record(value === "setup-hook" ? "resolve-setup" : "resolve-cleanup");
        return value;
      },
      runShell: async (input) => {
        record(`${input.kind}-hook`);
        return true;
      },
    },
    panes: {
      markShell: () => record("mark-shell"),
      restoreShell: () => record("restore-shell"),
    },
  });
  if (registerCleanup) registerCleanup(() => undefined);
  return { fixture };
}

describe("managed shell workflow", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
