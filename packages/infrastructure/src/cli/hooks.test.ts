import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, AgentSessionId, type AgentSessionRecord, WorkspaceId } from "@muximo/domain";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { createLogger, type LogRecord } from "../logging/index.js";
import { WorkspaceHookAdapter } from "./hooks.js";

type HookFixture = {
  root: string;
  workspaceRoot: string;
  hookOutputRoot: string;
  validHook: string;
  cleanupHook: string;
  failureHook: string;
  missingRunDirectory?: string;
  adapter: WorkspaceHookAdapter;
  session: AgentSessionRecord;
  records: LogRecord[];
  latest?: Awaited<ReturnType<WorkspaceHookAdapter["run"]>>;
  outputFiles: { setup?: string; cleanup?: string };
};

type ResolveInput = { path: string };
type ResolveContext = { resolved: string | undefined };

const resolveCases = [
  {
    name: "resolves an executable hook relative to the workspace",
    input: { path: "hooks/setup.sh" },
    assert: [
      {
        name: "returns the absolute hook path",
        check: (_context: ResolveContext, result: { ok: true; value: string } | { ok: false; error: unknown }) => {
          expect(result.ok).toBe(true);
          if (result.ok) expect(result.value).toContain("/workspace/hooks/setup.sh");
        },
      },
      hasObserved<ResolveContext, string>("resolved", "resolved"),
    ],
  },
  {
    name: "rejects a missing hook",
    input: { path: "hooks/missing.sh" },
    assert: [hasError<ResolveContext, string>({ message: "workspace hook does not exist: hooks/missing.sh" })],
  },
  {
    name: "rejects a hook directory",
    input: { path: "hooks/directory" },
    assert: [hasError<ResolveContext, string>({ message: /workspace hook is not a file/ })],
  },
] satisfies readonly OperationCase<"default", ResolveInput, string, ResolveContext>[];

const resolveTable: OperationTable<HookFixture, "default", ResolveInput, string, ResolveContext> = {
  defaultFixture: createHookFixture,
  cases: resolveCases,
  execute: async (fixture, input) => {
    const resolved = await fixture.adapter.resolveHook(input.path, fixture.workspaceRoot);
    return resolved;
  },
  observe: (_fixture, result) => ({
    resolved: result.ok && result.value.endsWith("/workspace/hooks/setup.sh") ? "resolved" : undefined,
  }),
};

type HookStep = { kind: "run"; hook: "setup" | "cleanup" } | { kind: "remove-outputs" };
type HookScenarioResult = {
  success: boolean | undefined;
  setupOutputExists: boolean;
  cleanupOutputExists: boolean;
  outputDirectoryExists: boolean;
  setupOutput: string;
  cleanupOutput: string;
  diagnostics: readonly string[];
};
type HookFixtureKey = "success" | "failure" | "missing-directory";

const hookCases = [
  {
    name: "persists setup and cleanup stdout as output artifacts",
    fixture: "success",
    steps: [
      { kind: "run", hook: "setup" },
      { kind: "run", hook: "cleanup" },
    ],
    assert: [
      hasObserved<HookScenarioResult, HookScenarioResult>("success", true),
      hasObserved<HookScenarioResult, HookScenarioResult>("setupOutputExists", true),
      hasObserved<HookScenarioResult, HookScenarioResult>("cleanupOutputExists", true),
      hasObserved<HookScenarioResult, HookScenarioResult>("setupOutput", "setup output\n"),
      hasObserved<HookScenarioResult, HookScenarioResult>("cleanupOutput", "cleanup output\n"),
      hasObserved<HookScenarioResult, HookScenarioResult>("diagnostics", [
        "info:hook.started:",
        "info:hook.finished:true",
        "info:hook.started:",
        "info:hook.finished:true",
      ]),
    ],
  },
  {
    name: "removes setup and cleanup output artifacts",
    fixture: "success",
    steps: [{ kind: "run", hook: "setup" }, { kind: "run", hook: "cleanup" }, { kind: "remove-outputs" }],
    assert: [
      hasObserved<HookScenarioResult, HookScenarioResult>("success", true),
      hasObserved<HookScenarioResult, HookScenarioResult>("setupOutputExists", false),
      hasObserved<HookScenarioResult, HookScenarioResult>("cleanupOutputExists", false),
      hasObserved<HookScenarioResult, HookScenarioResult>("outputDirectoryExists", false),
    ],
  },
  {
    name: "records a failed hook and preserves its output until cleanup",
    fixture: "failure",
    steps: [{ kind: "run", hook: "setup" }],
    assert: [
      hasObserved<HookScenarioResult, HookScenarioResult>("success", false),
      hasObserved<HookScenarioResult, HookScenarioResult>("setupOutputExists", true),
      hasObserved<HookScenarioResult, HookScenarioResult>("setupOutput", "failure output\n"),
      hasObserved<HookScenarioResult, HookScenarioResult>("diagnostics", [
        "info:hook.started:",
        "warn:hook.finished:false",
      ]),
    ],
  },
  {
    name: "reports a missing hook working directory without creating output",
    fixture: "missing-directory",
    steps: [{ kind: "run", hook: "setup" }],
    assert: [
      hasObserved<HookScenarioResult, HookScenarioResult>("success", false),
      hasObserved<HookScenarioResult, HookScenarioResult>("setupOutputExists", false),
      hasObserved<HookScenarioResult, HookScenarioResult>("setupOutput", ""),
      hasObserved<HookScenarioResult, HookScenarioResult>("diagnostics", ["warn:hook.skipped:run_directory_missing"]),
    ],
  },
] satisfies readonly ScenarioCase<HookFixtureKey, HookStep, HookScenarioResult, HookScenarioResult>[];

const hookTable: ScenarioTable<HookFixture, HookFixtureKey, HookStep, HookScenarioResult, HookScenarioResult> = {
  defaultFixture: createSuccessFixture,
  fixtures: {
    success: createSuccessFixture,
    failure: createFailureFixture,
    "missing-directory": createMissingDirectoryFixture,
  },
  cases: hookCases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.kind === "run") {
        fixture.latest = await fixture.adapter.run(fixture.session, step.hook);
        if (fixture.latest.sessionUpdate) {
          fixture.session = AgentSession.update(fixture.session, fixture.latest.sessionUpdate);
          fixture.outputFiles[step.hook] =
            step.hook === "setup" ? fixture.session.setupOutputFile : fixture.session.cleanupOutputFile;
        }
      } else {
        await fixture.adapter.removeOutputs(fixture.session);
      }
    }
    return observeHookScenario(fixture);
  },
  observe: (fixture) => observeHookScenario(fixture),
};

function createSuccessFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: HookFixture } {
  return createHookFixture(registerCleanup);
}

function createFailureFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: HookFixture } {
  const handle = createHookFixture(registerCleanup);
  handle.fixture.session = AgentSession.update(handle.fixture.session, { setupHook: handle.fixture.failureHook });
  return handle;
}

function createMissingDirectoryFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: HookFixture } {
  const handle = createHookFixture(registerCleanup);
  const missing = join(handle.fixture.root, "missing-run-directory");
  mkdirSync(missing, { recursive: true });
  handle.fixture.session = AgentSession.update(handle.fixture.session, { workspaceRoot: missing });
  rmSync(missing, { recursive: true, force: true });
  handle.fixture.missingRunDirectory = missing;
  return handle;
}

function createHookFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: HookFixture } {
  const root = mkdtempSync(join(tmpdir(), "muximo-hook-adapter-"));
  const workspaceRoot = join(root, "workspace");
  const hooksRoot = join(workspaceRoot, "hooks");
  const hookOutputRoot = join(root, "hook-output");
  mkdirSync(hooksRoot, { recursive: true });
  mkdirSync(join(hooksRoot, "directory"), { recursive: true });
  const validHook = join(hooksRoot, "setup.sh");
  const cleanupHook = join(hooksRoot, "cleanup.sh");
  const failureHook = join(hooksRoot, "failure.sh");
  writeExecutable(validHook, "#!/bin/sh\nprintf 'setup output\\n'\n");
  writeExecutable(cleanupHook, "#!/bin/sh\nprintf 'cleanup output\\n'\n");
  writeExecutable(failureHook, "#!/bin/sh\nprintf 'failure output\\n'\nexit 7\n");
  const records: LogRecord[] = [];
  const logger = createLogger({
    service: "hook-test",
    mode: "attached",
    level: "debug",
    sink: { write: (record) => records.push(record) },
    processInstanceId: "hook-test-process",
    pid: 1,
    clock: () => new Date("2026-08-23T00:00:00.000Z"),
  });
  const environment = { ...process.env, MUXIMO_HOOK_TEST: "1" };
  const session = AgentSession.create({
    id: AgentSessionId.create("hook-session"),
    name: "hook-session",
    backend: "claude",
    status: "exited",
    workspaceId: WorkspaceId.create("workspace-id"),
    workspaceRoot,
    workspaceName: "workspace",
    useWorktree: false,
    setupHook: validHook,
    cleanupHook,
    setupRan: false,
    resuming: false,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  });
  const fixture: HookFixture = {
    root,
    workspaceRoot,
    hookOutputRoot,
    validHook,
    cleanupHook,
    failureHook,
    adapter: new WorkspaceHookAdapter({
      environment,
      cwd: workspaceRoot,
      hookOutputRoot,
      logger,
    }),
    session,
    records,
    outputFiles: {},
  };
  const cleanup = () => {
    logger.close();
    rmSync(root, { recursive: true, force: true });
  };
  if (registerCleanup) registerCleanup(cleanup);
  return { fixture };
}

function observeHookScenario(fixture: HookFixture): HookScenarioResult {
  const outputDirectory = join(fixture.hookOutputRoot, fixture.session.id);
  return {
    success: fixture.latest?.success,
    setupOutputExists: fixture.outputFiles.setup ? existsSync(fixture.outputFiles.setup) : false,
    cleanupOutputExists: fixture.outputFiles.cleanup ? existsSync(fixture.outputFiles.cleanup) : false,
    outputDirectoryExists: existsSync(outputDirectory),
    setupOutput: readOutput(fixture.outputFiles.setup),
    cleanupOutput: readOutput(fixture.outputFiles.cleanup),
    diagnostics: fixture.records.map(
      (record) => `${record.level}:${record.event}:${String(record.fields.reason ?? record.fields.success ?? "")}`,
    ),
  };
}

function readOutput(path: string | undefined): string {
  return path && existsSync(path) ? readFileSync(path, "utf8") : "";
}

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o700 });
  chmodSync(path, 0o700);
}

describe("workspace hook CLI adapter", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, resolveTable);
  runScenarioTable(register, hookTable);
});
