import { Workspace, WorkspaceId } from "@muximo/domain";
import {
  hasError,
  hasEvents,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { Effect } from "effect";
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

type ShellFixtureKey = "success" | "failure" | "copy-failure" | "setup-failure" | "cleanup-failure" | "retained";
type Input = { shell?: string };

const cases = [
  {
    name: "runs shell setup and cleanup in order before restoring pane metadata",
    fixture: "success",
    input: {},
    assert: [
      hasObserved<ShellResult, ShellResult>("process", { started: true, code: 0, interrupted: false }),
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
      hasObserved<ShellResult, ShellResult>("process", { started: true, code: 3, interrupted: false }),
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
    name: "cleans up a worktree when copying workspace files fails",
    fixture: "copy-failure",
    input: {},
    assert: [
      hasError<ShellResult, ShellResult>({ message: "worktree file copy failed", _tag: "ApplicationFailure" }),
      hasObserved<ShellResult, ShellResult>("process", { started: false, code: -1, interrupted: false }),
      hasEvents<ShellResult, ShellResult>("events", [
        "mark-shell",
        "resolve-workspace",
        "create-worktree",
        "resolve-setup",
        "resolve-cleanup",
        "copy-files",
        "cleanup-hook",
        "remove-worktree",
        "restore-shell",
      ]),
    ],
  },
  {
    name: "cleans up a worktree when the setup hook fails",
    fixture: "setup-failure",
    input: {},
    assert: [
      hasError<ShellResult, ShellResult>({ message: "setup hook failed", _tag: "ApplicationFailure" }),
      hasObserved<ShellResult, ShellResult>("process", { started: false, code: -1, interrupted: false }),
      hasEvents<ShellResult, ShellResult>("events", [
        "mark-shell",
        "resolve-workspace",
        "create-worktree",
        "resolve-setup",
        "resolve-cleanup",
        "copy-files",
        "setup-hook",
        "cleanup-hook",
        "remove-worktree",
        "restore-shell",
      ]),
    ],
  },
  {
    name: "removes a worktree even when its cleanup hook reports failure",
    fixture: "cleanup-failure",
    input: {},
    assert: [
      hasError<ShellResult, ShellResult>({ message: "cleanup hook failed", _tag: "ApplicationFailure" }),
      hasObserved<ShellResult, ShellResult>("process", { started: false, code: -1, interrupted: false }),
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
    name: "reports when worktree safety policy retains the worktree",
    fixture: "retained",
    input: {},
    assert: [
      hasError<ShellResult, ShellResult>({
        message: "managed shell worktree was retained",
        _tag: "ApplicationFailure",
      }),
      hasObserved<ShellResult, ShellResult>("process", { started: false, code: -1, interrupted: false }),
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
    "copy-failure": () => createShellFixture(0, { copyFiles: false }),
    "setup-failure": () => createShellFixture(0, { setupHook: false }),
    "cleanup-failure": () => createShellFixture(0, { cleanupHook: false }),
    retained: () => createShellFixture(0, { removeWorktree: false }),
  },
  cases,
  execute: (fixture, input) =>
    Effect.gen(function* () {
      const result = yield* fixture.service.execute({
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
    }),
  observe: (fixture, result) => ({
    process: result.ok ? result.value.process : { started: false, code: -1, interrupted: false },
    events: [...fixture.events],
    shell: fixture.shellInputs.find((shellInput) => shellInput.interactive),
  }),
};

function createShellFixture(
  exitCode: number,
  behavior: Partial<{ copyFiles: boolean; setupHook: boolean; cleanupHook: boolean; removeWorktree: boolean }> = {},
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
      resolveCurrent: () =>
        Effect.sync(() => {
          record("resolve-workspace");
          return workspace;
        }),
    },
    sessions: {
      findWorktreePath: () => Effect.succeed(workspaceRoot),
    },
    process: {
      run: (input) =>
        Effect.sync(() => {
          fixture.shellInputs.push({ ...input, args: [...input.args] });
          record("shell");
          return { started: true, code: exitCode, interrupted: false };
        }),
    },
    worktrees: {
      create: () =>
        Effect.sync(() => {
          record("create-worktree");
          return {
            worktreeRoot: "/workspace/.worktrees",
            worktreePath,
            branch: "muximo/review",
            baseCommit: "base-commit",
          };
        }),
      copyFiles: () =>
        Effect.sync(() => {
          record("copy-files");
          return behavior.copyFiles ?? true;
        }),
      remove: () =>
        Effect.sync(() => {
          record("remove-worktree");
          return behavior.removeWorktree ?? true;
        }),
    },
    hooks: {
      resolveHook: (value: string) =>
        Effect.sync(() => {
          record(value === "setup-hook" ? "resolve-setup" : "resolve-cleanup");
          return value;
        }),
      runShell: (input) =>
        Effect.sync(() => {
          record(`${input.kind}-hook`);
          return input.kind === "setup" ? (behavior.setupHook ?? true) : (behavior.cleanupHook ?? true);
        }),
    },
    panes: {
      markShell: () => record("mark-shell"),
      restoreShell: () => record("restore-shell"),
    },
  });
  return { fixture };
}

describe("managed shell workflow", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
