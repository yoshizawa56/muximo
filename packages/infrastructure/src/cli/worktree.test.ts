import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CleanupResult } from "@muximo/application";
import { AgentSession, AgentSessionId, type AgentSessionRecord, Workspace, WorkspaceId } from "@muximo/domain";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { createLogger, type Logger, type LogRecord } from "../logging/index.js";
import { GitWorktreeAdapter } from "./worktree.js";

type WorktreeFixture = {
  root: string;
  workspaceRoot: string;
  worktreeRoot: string;
  environment: NodeJS.ProcessEnv;
  adapter: GitWorktreeAdapter;
  workspace: ReturnType<typeof Workspace.create>;
  session?: AgentSessionRecord;
  created?: Awaited<ReturnType<GitWorktreeAdapter["create"]>>;
  cleanup?: CleanupResult;
  shellPathExists?: boolean;
  copyResult?: boolean;
  diagnostics: LogRecord[];
  logger: Logger;
};

type LifecycleStep =
  | { kind: "create"; name: string }
  | { kind: "write"; relativePath: string; content: string }
  | { kind: "remove"; force: boolean }
  | { kind: "remove-shell" };

type LifecycleResult = {
  cleanup: CleanupResult | undefined;
  shellPathExists: boolean | undefined;
  deletionCommands: readonly string[];
  diagnosticEvents: readonly string[];
};

type LifecycleFixtureKey = "default" | "unregistered";

const lifecycleCases = [
  {
    name: "creates and removes a clean registered worktree",
    steps: [
      { kind: "create", name: "review" },
      { kind: "remove", force: false },
    ],
    assert: [
      hasObserved<LifecycleResult, LifecycleResult>("cleanup", { disposition: "removed" }),
      hasObserved<LifecycleResult, LifecycleResult>("shellPathExists", false),
      {
        name: "runs exactly one worktree removal command",
        check: (context: LifecycleResult) => {
          expect(context.deletionCommands).toHaveLength(1);
        },
      },
    ],
  },
  {
    name: "retains an existing unregistered path without invoking deletion",
    fixture: "unregistered",
    steps: [{ kind: "remove", force: true }],
    assert: [
      hasObserved<LifecycleResult, LifecycleResult>("cleanup", {
        disposition: "failed",
        reason: "unregistered_worktree",
      }),
      {
        name: "keeps the unregistered path",
        check: (context: LifecycleResult) => expect(context.shellPathExists).toBe(true),
      },
      hasObserved<LifecycleResult, LifecycleResult>("deletionCommands", []),
      {
        name: "reports the refusal",
        check: (context: LifecycleResult) =>
          expect(context.diagnosticEvents).toContain("worktree.remove_refused_unregistered"),
      },
    ],
  },
  {
    name: "keeps a dirty shell worktree and skips removal",
    steps: [
      { kind: "create", name: "shell" },
      { kind: "write", relativePath: "uncommitted.txt", content: "keep me\n" },
      { kind: "remove-shell" },
    ],
    assert: [
      {
        name: "keeps the dirty path",
        check: (context: LifecycleResult) => expect(context.shellPathExists).toBe(true),
      },
      hasObserved<LifecycleResult, LifecycleResult>("deletionCommands", []),
      {
        name: "reports the dirty worktree",
        check: (context: LifecycleResult) =>
          expect(context.diagnosticEvents).toContain("worktree.shell_remove_refused_dirty"),
      },
    ],
  },
] satisfies readonly ScenarioCase<LifecycleFixtureKey, LifecycleStep, LifecycleResult, LifecycleResult>[];

const lifecycleTable: ScenarioTable<
  WorktreeFixture,
  LifecycleFixtureKey,
  LifecycleStep,
  LifecycleResult,
  LifecycleResult
> = {
  defaultFixture: createWorktreeFixture,
  fixtures: {
    default: createWorktreeFixture,
    unregistered: createUnregisteredFixture,
  },
  cases: lifecycleCases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.kind === "create") {
        fixture.created = await fixture.adapter.create(fixture.workspace, step.name);
        fixture.session = createSession(fixture, fixture.created);
        continue;
      }
      if (step.kind === "write") {
        if (!fixture.created?.worktreePath) throw new Error("test worktree was not created");
        const path = resolve(fixture.created.worktreePath, step.relativePath);
        mkdirSync(resolve(path, ".."), { recursive: true });
        writeFileSync(path, step.content);
        continue;
      }
      if (step.kind === "remove") {
        if (!fixture.session) throw new Error("test session was not created");
        fixture.cleanup = await fixture.adapter.remove(fixture.session, step.force);
        continue;
      }
      if (step.kind === "remove-shell") {
        if (!fixture.created?.worktreePath) throw new Error("test worktree was not created");
        fixture.adapter.removeShell({
          workspaceRoot: fixture.workspaceRoot,
          worktreeRoot: fixture.created.worktreeRoot ?? null,
          worktreePath: fixture.created.worktreePath,
          branch: fixture.created.branch ?? null,
          baseCommit: fixture.created.baseCommit ?? null,
        });
      }
    }
    fixture.shellPathExists = fixture.session?.worktreePath
      ? existsSync(fixture.session.worktreePath)
      : fixture.created?.worktreePath
        ? existsSync(fixture.created.worktreePath)
        : undefined;
    return {
      cleanup: fixture.cleanup,
      shellPathExists: fixture.shellPathExists,
      deletionCommands: gitCommands(fixture).filter((command) => command.includes("worktree remove")),
      diagnosticEvents: fixture.diagnostics.map((record) => record.event),
    };
  },
  observe: (fixture) => ({
    cleanup: fixture.cleanup,
    shellPathExists: fixture.shellPathExists,
    deletionCommands: gitCommands(fixture).filter((command) => command.includes("worktree remove")),
    diagnosticEvents: fixture.diagnostics.map((record) => record.event),
  }),
};

type CopyInput = {
  patterns: readonly string[];
};

type CopyContext = {
  result: boolean | undefined;
  copiedPath: string | undefined;
  outsidePath: string;
  diagnosticEvents: readonly string[];
};

const copyCases = [
  {
    name: "copies an unmanaged file into a registered worktree",
    input: { patterns: [".env"] },
    assert: [
      returns<CopyContext, boolean>(true),
      hasObserved<CopyContext, boolean>("result", true),
      hasObserved<CopyContext, boolean>("copiedPath", "copied"),
      hasObserved<CopyContext, boolean>("diagnosticEvents", []),
    ],
  },
  {
    name: "refuses a parent traversal copy pattern",
    input: { patterns: ["../outside"] },
    assert: [
      returns<CopyContext, boolean>(false),
      hasObserved<CopyContext, boolean>("result", false),
      hasObserved<CopyContext, boolean>("copiedPath", undefined),
      hasObserved<CopyContext, boolean>("diagnosticEvents", ["worktree.copy_pattern_invalid"]),
    ],
  },
  {
    name: "refuses to copy through a worktree symlink",
    fixture: "symlink",
    input: { patterns: ["nested/secret.txt"] },
    assert: [
      returns<CopyContext, boolean>(false),
      hasObserved<CopyContext, boolean>("result", false),
      hasObserved<CopyContext, boolean>("copiedPath", undefined),
      {
        name: "reports the containment refusal",
        check: (context: CopyContext) => expect(context.diagnosticEvents).toContain("worktree.copy_refused"),
      },
    ],
  },
] satisfies readonly OperationCase<"default" | "symlink", CopyInput, boolean, CopyContext>[];

const copyTable: OperationTable<WorktreeFixture, "default" | "symlink", CopyInput, boolean, CopyContext> = {
  defaultFixture: createCopyFixture,
  fixtures: { default: createCopyFixture, symlink: createSymlinkFixture },
  cases: copyCases,
  execute: async (fixture, input) => {
    if (!fixture.created?.worktreePath) throw new Error("copy fixture worktree is missing");
    fixture.copyResult = await fixture.adapter.copyFiles(
      { workspaceRoot: fixture.workspaceRoot, worktreePath: fixture.created.worktreePath },
      input.patterns,
    );
    return fixture.copyResult;
  },
  observe: (fixture) => ({
    result: fixture.copyResult,
    copiedPath: fixture.created?.worktreePath
      ? existsSync(join(fixture.created.worktreePath, ".env"))
        ? "copied"
        : undefined
      : undefined,
    outsidePath: join(fixture.root, "outside", "secret.txt"),
    diagnosticEvents: fixture.diagnostics.map((record) => record.event),
  }),
};

function createWorktreeFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: WorktreeFixture } {
  const fixture = createGitFixture();
  registerFixtureCleanup(fixture, registerCleanup);
  return { fixture };
}

function createUnregisteredFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: WorktreeFixture } {
  const fixture = createGitFixture();
  const worktreePath = join(fixture.worktreeRoot, "unregistered");
  mkdirSync(worktreePath, { recursive: true });
  fixture.session = createSession(fixture, {
    worktreeRoot: fixture.worktreeRoot,
    worktreePath,
    branch: "muximo/unregistered",
    baseCommit: git(fixture, ["rev-parse", "HEAD"]),
  });
  registerFixtureCleanup(fixture, registerCleanup);
  return { fixture };
}

function createCopyFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: WorktreeFixture } {
  const fixture = createGitFixture();
  arrangeRawWorktree(fixture, "copy");
  writeFileSync(join(fixture.workspaceRoot, ".env"), "secret\n");
  registerFixtureCleanup(fixture, registerCleanup);
  return { fixture };
}

function createSymlinkFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: WorktreeFixture } {
  const fixture = createGitFixture();
  arrangeRawWorktree(fixture, "symlink");
  const source = join(fixture.workspaceRoot, "nested", "secret.txt");
  mkdirSync(resolve(source, ".."), { recursive: true });
  writeFileSync(source, "secret\n");
  const outside = join(fixture.root, "outside");
  mkdirSync(outside, { recursive: true });
  symlinkSync(outside, join(fixture.created?.worktreePath ?? join(fixture.worktreeRoot, "symlink"), "nested"));
  registerFixtureCleanup(fixture, registerCleanup);
  return { fixture };
}

function createGitFixture(): WorktreeFixture {
  const root = mkdtempSync(join(tmpdir(), "muximo-worktree-adapter-"));
  const workspacePath = join(root, "workspace");
  const worktreePath = join(root, "worktrees");
  const binRoot = join(root, "bin");
  const gitLog = join(root, "git.log");
  mkdirSync(workspacePath, { recursive: true });
  mkdirSync(worktreePath, { recursive: true });
  const workspaceRoot = realpathSync(workspacePath);
  const worktreeRoot = realpathSync(worktreePath);
  mkdirSync(binRoot, { recursive: true });
  writeFileSync(join(workspaceRoot, "README.md"), "fixture\n");
  const realGit = findExecutable("git");
  const wrappedGit = join(binRoot, "git");
  writeFileSync(wrappedGit, `#!/bin/sh\nprintf '%s\\n' "$*" >>"$MUXIMO_GIT_LOG"\nexec ${shellQuote(realGit)} "$@"\n`, {
    mode: 0o700,
  });
  chmodSync(wrappedGit, 0o700);
  execFileSync(realGit, ["init", "-q", workspaceRoot]);
  execFileSync(realGit, ["-C", workspaceRoot, "config", "user.email", "adapter@example.invalid"]);
  execFileSync(realGit, ["-C", workspaceRoot, "config", "user.name", "Adapter Test"]);
  execFileSync(realGit, ["-C", workspaceRoot, "add", "README.md"]);
  execFileSync(realGit, ["-C", workspaceRoot, "commit", "-q", "-m", "fixture"]);
  const diagnostics: LogRecord[] = [];
  const logger = createLogger({
    service: "worktree-adapter-test",
    mode: "attached",
    level: "debug",
    clock: () => new Date("2026-08-23T00:00:00.000Z"),
    sink: { write: (record) => diagnostics.push(record) },
  });
  const environment = {
    ...process.env,
    PATH: `${binRoot}:${process.env.PATH ?? ""}`,
    MUXIMO_GIT_LOG: gitLog,
    MUXIMO_WORKTREE_ROOT: worktreeRoot,
    MUXIMO_WORKTREE_ID: "adapter-test",
  };
  const workspace = Workspace.create({
    id: WorkspaceId.create("workspace-id"),
    rootPath: workspaceRoot,
    name: "workspace",
    isGit: true,
    worktreeCopyPatterns: [],
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  });
  return {
    root,
    workspaceRoot,
    worktreeRoot,
    environment,
    adapter: new GitWorktreeAdapter({
      environment,
      logger,
    }),
    workspace,
    diagnostics,
    logger,
  };
}

function arrangeRawWorktree(fixture: WorktreeFixture, name: string): void {
  const path = join(fixture.worktreeRoot, name);
  execFileSync(findExecutable("git"), [
    "-C",
    fixture.workspaceRoot,
    "worktree",
    "add",
    "-q",
    "-b",
    `fixture/${name}`,
    path,
    "HEAD",
  ]);
  fixture.created = { worktreeRoot: fixture.worktreeRoot, worktreePath: path, branch: `fixture/${name}` };
}

function createSession(
  fixture: WorktreeFixture,
  worktree: Pick<NonNullable<WorktreeFixture["created"]>, "worktreeRoot" | "worktreePath" | "branch" | "baseCommit">,
): AgentSessionRecord {
  return AgentSession.create({
    id: AgentSessionId.create("session-id"),
    name: "session",
    backend: "claude",
    status: "exited",
    workspaceId: fixture.workspace.id,
    workspaceRoot: fixture.workspaceRoot,
    workspaceName: fixture.workspace.name,
    ...worktree,
    useWorktree: true,
    setupRan: false,
    resuming: false,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  });
}

function registerFixtureCleanup(fixture: WorktreeFixture, registerCleanup?: (cleanup: () => void) => void): void {
  const cleanup = () => {
    fixture.logger.close();
    rmSync(fixture.root, { recursive: true, force: true });
  };
  if (registerCleanup) registerCleanup(cleanup);
}

function git(fixture: WorktreeFixture, args: readonly string[]): string {
  return execFileSync(findExecutable("git"), ["-C", fixture.workspaceRoot, ...args], { encoding: "utf8" }).trim();
}

function gitCommands(fixture: WorktreeFixture): string[] {
  try {
    return readFileSync(fixture.environment.MUXIMO_GIT_LOG ?? "", "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function findExecutable(name: string): string {
  const path = (process.env.PATH ?? "")
    .split(":")
    .map((directory) => join(directory, name))
    .find(existsSync);
  if (!path) throw new Error(`${name} executable is required for the adapter fixture`);
  return path;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("git worktree CLI adapter", () => {
  const register = it as unknown as TestRegistrar;
  runScenarioTable(register, lifecycleTable);
  runOperationTable(register, copyTable);
});
