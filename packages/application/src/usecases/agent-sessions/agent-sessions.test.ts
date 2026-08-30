import {
  AgentSession,
  AgentSessionId,
  type AgentSessionRecord,
  WorkspaceId,
  type WorkspaceRecord,
} from "@muximo/domain";
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
import { describe, it } from "vitest";
import {
  type ClaimExecutionInput,
  CleanupAgentSession,
  type CleanupAgentSessionResult,
  type CleanupDisposition,
  type CleanupResult,
  LocateAgentSession,
  type ProcessResult,
  ResumeAgentSession,
  type ResumeAgentSessionResult,
  RunAgentSession,
  type RunAgentSessionResult,
  type SessionIdentityUpdate,
  type WorkspaceResolutionInput,
} from "../../index.js";

type LifecycleFixture = {
  sessions: Map<string, AgentSessionRecord>;
  workspace: WorkspaceRecord;
  processResult: ProcessResult;
  processError?: Error;
  prepareError?: Error;
  hasChangesError?: Error;
  useWorktree: boolean;
  cleanupDisposition: CleanupDisposition;
  restoreSucceeded: boolean;
  confirmCleanup: boolean;
  provideBackendSessionId: boolean;
  processAlive: boolean;
  dirty: boolean;
  runCount: number;
  disposeCount: number;
  adoptCount: number;
  releaseCount: number;
  confirmCount: number;
  cleanupForce: boolean | undefined;
  worktreeRemoveCount: number;
  cleanupHookCount: number;
  archiveCount: number;
  restoreCount: number;
  deleted: boolean;
  adoptedPaneId: string | undefined;
  releasedPaneId: string | undefined;
  providerUpdates: SessionIdentityUpdate[];
  runWorkspaceInput?: WorkspaceResolutionInput;
  resolvedWorkspaceInput: WorkspaceResolutionInput | undefined;
  claim?: ClaimExecutionInput;
};

type RunContext = {
  status: AgentSessionRecord["status"] | undefined;
  processCode: number | undefined;
  cleanup: RunAgentSessionResult["cleanup"] | undefined;
  runCount: number;
  disposeCount: number;
  adoptCount: number;
  releaseCount: number;
  confirmCount: number;
  cleanupForce: boolean | undefined;
  archiveCount: number;
  adoptedPaneId: string | undefined;
  releasedPaneId: string | undefined;
  worktreeRemoveCount: number;
  cleanupHookCount: number;
  providerUpdates: readonly SessionIdentityUpdate[];
  deleted: boolean;
  failureDiagnostic: string | undefined;
  resolvedWorkspaceInput: WorkspaceResolutionInput | undefined;
};

type ResumeContext = {
  status: AgentSessionRecord["status"] | undefined;
  processCode: number | undefined;
  runCount: number;
  disposeCount: number;
  adoptedPaneId: string | undefined;
  releasedPaneId: string | undefined;
  claimUpdatedAt?: string;
};

type CleanupContext = {
  cleanup: CleanupResult | undefined;
  archiveCount: number;
  restoreCount: number;
  deleted: boolean;
};

const workspace: WorkspaceRecord = {
  id: WorkspaceId.create("workspace-id"),
  rootPath: "/workspace",
  name: "workspace",
  isGit: false,
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:00.000Z",
};

function sessionFixture(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return AgentSession.create({
    id: AgentSessionId.create("session-id"),
    name: "session",
    backend: "codex",
    status: "interrupted",
    workspaceId: workspace.id,
    workspaceRoot: workspace.rootPath,
    workspaceName: workspace.name,
    useWorktree: false,
    setupRan: false,
    resuming: false,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  });
}

function createFixture(
  options: {
    session?: AgentSessionRecord;
    processResult?: ProcessResult;
    processError?: Error;
    prepareError?: Error;
    hasChangesError?: Error;
    useWorktree?: boolean;
    cleanupDisposition?: CleanupDisposition;
    restoreSucceeded?: boolean;
    confirmCleanup?: boolean;
    provideBackendSessionId?: boolean;
    processAlive?: boolean;
    dirty?: boolean;
    runWorkspaceInput?: WorkspaceResolutionInput;
  } = {},
): LifecycleFixture {
  const sessions = new Map<string, AgentSessionRecord>();
  if (options.session) sessions.set(options.session.id, options.session);
  return {
    sessions,
    workspace,
    processResult: options.processResult ?? { started: true, code: 0, interrupted: false },
    processError: options.processError,
    prepareError: options.prepareError,
    hasChangesError: options.hasChangesError,
    useWorktree: options.useWorktree ?? false,
    cleanupDisposition: options.cleanupDisposition ?? "removed",
    restoreSucceeded: options.restoreSucceeded ?? true,
    confirmCleanup: options.confirmCleanup ?? true,
    provideBackendSessionId: options.provideBackendSessionId ?? true,
    processAlive: options.processAlive ?? false,
    dirty: options.dirty ?? false,
    runCount: 0,
    disposeCount: 0,
    adoptCount: 0,
    releaseCount: 0,
    confirmCount: 0,
    cleanupForce: undefined,
    worktreeRemoveCount: 0,
    cleanupHookCount: 0,
    archiveCount: 0,
    restoreCount: 0,
    deleted: false,
    adoptedPaneId: undefined,
    releasedPaneId: undefined,
    providerUpdates: [],
    runWorkspaceInput: options.runWorkspaceInput,
    resolvedWorkspaceInput: undefined,
  };
}

function cleanupResult(disposition: CleanupDisposition): CleanupResult {
  if (disposition === "removed") return { disposition };
  return { disposition, reason: "worktree_removal_failed" };
}

function repository(fixture: LifecycleFixture) {
  return {
    findById: async (id: AgentSessionId) => fixture.sessions.get(id),
    findByName: async (workspaceId: WorkspaceId, name: string) =>
      [...fixture.sessions.values()].find((session) => session.workspaceId === workspaceId && session.name === name),
    list: async (workspaceId?: WorkspaceId) =>
      [...fixture.sessions.values()].filter(
        (session) => workspaceId === undefined || session.workspaceId === workspaceId,
      ),
    insert: async (record: AgentSessionRecord) => {
      fixture.sessions.set(record.id, record);
    },
    update: async (record: AgentSessionRecord) => {
      fixture.sessions.set(record.id, record);
    },
    claimExecution: async (input: ClaimExecutionInput) => {
      fixture.claim = input;
      return true;
    },
    delete: async (id: AgentSessionId) => {
      fixture.sessions.delete(id);
      fixture.deleted = true;
    },
  };
}

function clock() {
  let id = 0;
  return {
    now: () => "2026-08-23T00:01:00.000Z",
    id: () => `generated-${++id}`,
  };
}

function logger() {
  const value = { child: () => value, debug: () => undefined };
  return value;
}

function createRunUseCase(fixture: LifecycleFixture): RunAgentSession {
  const sessions = repository(fixture);
  const backend = {
    captureBaseline: async () => ({ success: true }),
    prepareLaunch: async () => {
      if (fixture.prepareError) throw fixture.prepareError;
      return {
        plan: {
          run: async () => {
            fixture.runCount += 1;
            if (fixture.processError) throw fixture.processError;
            const sessionUpdate = fixture.provideBackendSessionId
              ? ({ backendSessionId: "backend-session" } satisfies SessionIdentityUpdate)
              : undefined;
            if (sessionUpdate) fixture.providerUpdates.push(sessionUpdate);
            return {
              process: fixture.processResult,
              ...(sessionUpdate === undefined ? {} : { sessionUpdate }),
            };
          },
          dispose: async () => {
            fixture.disposeCount += 1;
          },
        },
      };
    },
  };
  return new RunAgentSession({
    sessions,
    workspace: {
      resolveCurrent: async (input) => {
        fixture.resolvedWorkspaceInput = input;
        return fixture.workspace;
      },
    },
    naming: { resolveName: async (_workspaceId, requestedName) => requestedName ?? "session" },
    hooks: {
      resolveHook: async (value) => value,
      resolveStoredHook: async () => undefined,
      run: async (_session, kind) => {
        if (kind === "cleanup") fixture.cleanupHookCount += 1;
        return { success: true };
      },
      removeOutputs: async () => undefined,
    },
    worktrees: {
      create: async () =>
        fixture.useWorktree
          ? {
              worktreeRoot: "/worktrees",
              worktreePath: "/worktrees/session",
              branch: "muximo/session",
              baseCommit: "base-commit",
            }
          : {},
      copyFiles: async () => true,
      isRegistered: async () => true,
      hasChanges: async () => {
        if (fixture.hasChangesError) throw fixture.hasChangesError;
        return fixture.dirty;
      },
      remove: async (_session, force) => {
        fixture.worktreeRemoveCount += 1;
        fixture.cleanupForce = force;
        return cleanupResult(fixture.cleanupDisposition);
      },
    },
    launcher: backend,
    remote: {
      archive: async () => {
        fixture.archiveCount += 1;
        return true;
      },
      restore: async () => {
        fixture.restoreCount += 1;
        return fixture.restoreSucceeded;
      },
    },
    resources: { releaseIfUnused: async () => undefined },
    panes: {
      adopt: async (_session, hostPaneId) => {
        fixture.adoptCount += 1;
        fixture.adoptedPaneId = hostPaneId;
      },
      release: async (_session, hostPaneId) => {
        fixture.releaseCount += 1;
        fixture.releasedPaneId = hostPaneId;
      },
      publish: async () => undefined,
    },
    audit: { record: async () => undefined },
    clock: clock(),
    logger: logger(),
    confirmCleanup: {
      confirm: async () => {
        fixture.confirmCount += 1;
        return fixture.confirmCleanup;
      },
    },
    execution: { ownerPid: 700, execute: async () => fixture.processResult },
  });
}

function createResumeUseCase(fixture: LifecycleFixture): ResumeAgentSession {
  const sessions = repository(fixture);
  const backend = {
    captureBaseline: async () => ({ success: true }),
    prepareLaunch: async () => ({
      plan: {
        run: async () => {
          fixture.runCount += 1;
          if (fixture.processError) throw fixture.processError;
          return { process: fixture.processResult };
        },
        dispose: async () => {
          fixture.disposeCount += 1;
        },
      },
    }),
  };
  return new ResumeAgentSession({
    sessions,
    locator: new LocateAgentSession({
      sessions,
      workspace: { resolveCurrent: async () => fixture.workspace },
    }),
    process: { isAlive: async () => fixture.processAlive },
    launcher: backend,
    panes: {
      adopt: async (_session, hostPaneId) => {
        fixture.adoptCount += 1;
        fixture.adoptedPaneId = hostPaneId;
      },
      release: async (_session, hostPaneId) => {
        fixture.releaseCount += 1;
        fixture.releasedPaneId = hostPaneId;
      },
      publish: async () => undefined,
    },
    clock: clock(),
    logger: logger(),
    execution: { ownerPid: 700, execute: async () => fixture.processResult },
  });
}

function createCleanupUseCase(fixture: LifecycleFixture): CleanupAgentSession {
  const sessions = repository(fixture);
  return new CleanupAgentSession({
    sessions,
    locator: new LocateAgentSession({
      sessions,
      workspace: { resolveCurrent: async () => fixture.workspace },
    }),
    process: { isAlive: async () => fixture.processAlive },
    worktrees: {
      create: async () => ({}),
      copyFiles: async () => true,
      isRegistered: async () => true,
      hasChanges: async () => fixture.dirty,
      remove: async () => cleanupResult(fixture.cleanupDisposition),
    },
    hooks: {
      resolveHook: async (value) => value,
      resolveStoredHook: async () => undefined,
      run: async () => ({ success: true }),
      removeOutputs: async () => undefined,
    },
    remote: {
      archive: async () => {
        fixture.archiveCount += 1;
        return true;
      },
      restore: async () => {
        fixture.restoreCount += 1;
        return fixture.restoreSucceeded;
      },
    },
    resources: { releaseIfUnused: async () => undefined },
    audit: { record: async () => undefined },
    confirmCleanup: { confirm: async () => fixture.confirmCleanup },
    clock: clock(),
  });
}

const runInput = {
  backend: "codex" as const,
  name: "session",
  useWorktree: false,
  setupHookExplicit: false,
  cleanupHookExplicit: false,
  hostPaneId: "%1",
  backendArgs: [] as readonly string[],
};

type RunKey =
  | "success"
  | "failed"
  | "startup-failed"
  | "startup-exit"
  | "started-exit"
  | "prepare-failed"
  | "post-execution-failed"
  | "resolution-input";
type RunStep = { operation: "run" };
const runCases = [
  {
    name: "runs a session, applies learned identity, and disposes once",
    fixture: "success",
    steps: [{ operation: "run" }],
    assert: [
      hasObserved<RunContext, RunAgentSessionResult>("status", "exited"),
      hasObserved<RunContext, RunAgentSessionResult>("processCode", 0),
      hasObserved<RunContext, RunAgentSessionResult>("cleanup", {
        disposition: "not_requested",
        reason: "no_worktree",
      }),
      hasObserved<RunContext, RunAgentSessionResult>("runCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("disposeCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("adoptCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("releaseCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("adoptedPaneId", "%1"),
      hasObserved<RunContext, RunAgentSessionResult>("releasedPaneId", "%1"),
      hasObserved<RunContext, RunAgentSessionResult>("providerUpdates", [{ backendSessionId: "backend-session" }]),
    ],
  },
  {
    name: "forwards workspace selection and cwd to the workspace resolver",
    fixture: "resolution-input",
    steps: [{ operation: "run" }],
    assert: [
      hasObserved<RunContext, RunAgentSessionResult>("resolvedWorkspaceInput", {
        workspace: "selected",
        cwd: "/caller/worktree",
      }),
    ],
  },
  {
    name: "disposes a failed run exactly once",
    fixture: "failed",
    steps: [{ operation: "run" }],
    assert: [
      hasError<RunContext, RunAgentSessionResult>({ message: "backend process failed" }),
      hasObserved<RunContext, RunAgentSessionResult>("status", undefined),
      hasObserved<RunContext, RunAgentSessionResult>("runCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("disposeCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("releaseCount", 1),
    ],
  },
  {
    name: "removes a worktree and mapping when the agent process fails during startup",
    fixture: "startup-failed",
    steps: [{ operation: "run" }],
    assert: [
      hasError<RunContext, RunAgentSessionResult>({ message: "backend process failed" }),
      hasObserved<RunContext, RunAgentSessionResult>("status", undefined),
      hasObserved<RunContext, RunAgentSessionResult>("worktreeRemoveCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("cleanupHookCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("disposeCount", 1),
    ],
  },
  {
    name: "removes a clean worktree after a non-zero startup exit without confirmation",
    fixture: "startup-exit",
    steps: [{ operation: "run" }],
    assert: [
      hasObserved<RunContext, RunAgentSessionResult>("status", undefined),
      hasObserved<RunContext, RunAgentSessionResult>("processCode", 1),
      hasObserved<RunContext, RunAgentSessionResult>("failureDiagnostic", "backend failed to initialize"),
      hasObserved<RunContext, RunAgentSessionResult>("cleanup", { disposition: "removed" }),
      hasObserved<RunContext, RunAgentSessionResult>("confirmCount", 0),
      hasObserved<RunContext, RunAgentSessionResult>("cleanupForce", true),
      hasObserved<RunContext, RunAgentSessionResult>("archiveCount", 0),
      hasObserved<RunContext, RunAgentSessionResult>("worktreeRemoveCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("deleted", true),
    ],
  },
  {
    name: "retains a worktree after a non-zero exit from a started process without a backend session id",
    fixture: "started-exit",
    steps: [{ operation: "run" }],
    assert: [
      hasObserved<RunContext, RunAgentSessionResult>("status", "exited"),
      hasObserved<RunContext, RunAgentSessionResult>("cleanup", {
        disposition: "retained",
        reason: "cleanup_declined",
      }),
      hasObserved<RunContext, RunAgentSessionResult>("confirmCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("worktreeRemoveCount", 0),
    ],
  },
  {
    name: "removes a worktree and mapping when launch preparation fails",
    fixture: "prepare-failed",
    steps: [{ operation: "run" }],
    assert: [
      hasError<RunContext, RunAgentSessionResult>({ message: "agent launch preparation failed" }),
      hasObserved<RunContext, RunAgentSessionResult>("status", undefined),
      hasObserved<RunContext, RunAgentSessionResult>("worktreeRemoveCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("cleanupHookCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("disposeCount", 0),
    ],
  },
  {
    name: "retains a completed session when post-execution finalization fails",
    fixture: "post-execution-failed",
    steps: [{ operation: "run" }],
    assert: [
      hasError<RunContext, RunAgentSessionResult>({ message: "post-execution observation failed" }),
      hasObserved<RunContext, RunAgentSessionResult>("status", "exited"),
      hasObserved<RunContext, RunAgentSessionResult>("worktreeRemoveCount", 0),
      hasObserved<RunContext, RunAgentSessionResult>("cleanupHookCount", 0),
      hasObserved<RunContext, RunAgentSessionResult>("disposeCount", 1),
    ],
  },
] satisfies readonly ScenarioCase<RunKey, RunStep, RunAgentSessionResult, RunContext>[];

const runTable: ScenarioTable<LifecycleFixture, RunKey, RunStep, RunAgentSessionResult, RunContext> = {
  defaultFixture: () => ({ fixture: createFixture() }),
  fixtures: {
    success: () => ({ fixture: createFixture({ processResult: { started: true, code: 0, interrupted: false } }) }),
    failed: () => ({ fixture: createFixture({ processError: new Error("backend process failed") }) }),
    "startup-failed": () => ({
      fixture: createFixture({
        useWorktree: true,
        processError: new Error("backend process failed"),
      }),
    }),
    "startup-exit": () => ({
      fixture: createFixture({
        useWorktree: true,
        provideBackendSessionId: false,
        processResult: {
          started: false,
          code: 1,
          interrupted: false,
          failureDiagnostic: "backend failed to initialize",
        },
      }),
    }),
    "started-exit": () => ({
      fixture: createFixture({
        useWorktree: true,
        confirmCleanup: false,
        provideBackendSessionId: false,
        processResult: { started: true, code: 1, interrupted: false, failureDiagnostic: "agent task failed" },
      }),
    }),
    "prepare-failed": () => ({
      fixture: createFixture({
        useWorktree: true,
        prepareError: new Error("agent launch preparation failed"),
      }),
    }),
    "post-execution-failed": () => ({
      fixture: createFixture({
        useWorktree: true,
        hasChangesError: new Error("post-execution observation failed"),
      }),
    }),
    "resolution-input": () => ({
      fixture: createFixture({
        runWorkspaceInput: { workspace: "selected", cwd: "/caller/worktree" },
      }),
    }),
  },
  cases: runCases,
  execute: async (fixture, steps) => {
    if (steps[0]?.operation !== "run") throw new Error("run scenario has no run step");
    return createRunUseCase(fixture).execute({
      ...runInput,
      ...(fixture.runWorkspaceInput ?? {}),
      useWorktree: fixture.useWorktree,
    });
  },
  observe: (fixture, result) => {
    const session = [...fixture.sessions.values()][0];
    return {
      status: session?.status,
      processCode: result.ok ? result.value.process.code : undefined,
      cleanup: result.ok ? result.value.cleanup : undefined,
      runCount: fixture.runCount,
      disposeCount: fixture.disposeCount,
      adoptCount: fixture.adoptCount,
      releaseCount: fixture.releaseCount,
      confirmCount: fixture.confirmCount,
      cleanupForce: fixture.cleanupForce,
      archiveCount: fixture.archiveCount,
      adoptedPaneId: fixture.adoptedPaneId,
      releasedPaneId: fixture.releasedPaneId,
      worktreeRemoveCount: fixture.worktreeRemoveCount,
      cleanupHookCount: fixture.cleanupHookCount,
      providerUpdates: fixture.providerUpdates,
      deleted: fixture.deleted,
      failureDiagnostic: result.ok ? result.value.process.failureDiagnostic : undefined,
      resolvedWorkspaceInput: fixture.resolvedWorkspaceInput,
    };
  },
};

type ResumeKey = "success" | "failed";
type ResumeStep = { operation: "resume" };
const resumeCases = [
  {
    name: "resumes a session with an application-owned claim timestamp",
    fixture: "success",
    steps: [{ operation: "resume" }],
    assert: [
      hasObserved<ResumeContext, ResumeAgentSessionResult>("status", "exited"),
      hasObserved<ResumeContext, ResumeAgentSessionResult>("processCode", 0),
      hasObserved<ResumeContext, ResumeAgentSessionResult>("runCount", 1),
      hasObserved<ResumeContext, ResumeAgentSessionResult>("disposeCount", 1),
      hasObserved<ResumeContext, ResumeAgentSessionResult>("adoptedPaneId", "%2"),
      hasObserved<ResumeContext, ResumeAgentSessionResult>("releasedPaneId", "%2"),
      hasObserved<ResumeContext, ResumeAgentSessionResult>("claimUpdatedAt", "2026-08-23T00:01:00.000Z"),
    ],
  },
  {
    name: "disposes a failed resume exactly once",
    fixture: "failed",
    steps: [{ operation: "resume" }],
    assert: [
      hasError<ResumeContext, ResumeAgentSessionResult>({ message: "backend process failed" }),
      hasObserved<ResumeContext, ResumeAgentSessionResult>("status", "exited"),
      hasObserved<ResumeContext, ResumeAgentSessionResult>("disposeCount", 1),
    ],
  },
] satisfies readonly ScenarioCase<ResumeKey, ResumeStep, ResumeAgentSessionResult, ResumeContext>[];

const resumeTable: ScenarioTable<LifecycleFixture, ResumeKey, ResumeStep, ResumeAgentSessionResult, ResumeContext> = {
  defaultFixture: () => ({ fixture: createFixture({ session: sessionFixture({ name: "resume" }) }) }),
  fixtures: {
    success: () => ({ fixture: createFixture({ session: sessionFixture({ name: "resume", status: "interrupted" }) }) }),
    failed: () => ({
      fixture: createFixture({
        session: sessionFixture({ name: "resume", status: "interrupted" }),
        processError: new Error("backend process failed"),
      }),
    }),
  },
  cases: resumeCases,
  execute: async (fixture, steps) => {
    if (steps[0]?.operation !== "resume") throw new Error("resume scenario has no resume step");
    return createResumeUseCase(fixture).execute({
      workspaceScope: "current",
      reference: "resume",
      hostPaneId: "%2",
      backendArgs: [],
    });
  },
  observe: (fixture, result) => {
    const session = [...fixture.sessions.values()][0];
    return {
      status: session?.status,
      processCode: result.ok ? result.value.process.code : undefined,
      runCount: fixture.runCount,
      disposeCount: fixture.disposeCount,
      adoptedPaneId: fixture.adoptedPaneId,
      releasedPaneId: fixture.releasedPaneId,
      claimUpdatedAt: fixture.claim?.updatedAt,
    };
  },
};

type CleanupKey = "removed" | "retained" | "failed" | "restore-failed" | "cancelled" | "running";
type CleanupInput = { reference: string; force: boolean };
const cleanupCases = [
  {
    name: "removes resources and deletes the mapping",
    fixture: "removed",
    input: { reference: "session", force: false },
    assert: [
      hasObserved<CleanupContext, CleanupAgentSessionResult>("cleanup", { disposition: "removed" }),
      hasObserved<CleanupContext, CleanupAgentSessionResult>("deleted", true),
      hasObserved<CleanupContext, CleanupAgentSessionResult>("archiveCount", 0),
    ],
  },
  {
    name: "retains a mapping when worktree cleanup is retained",
    fixture: "retained",
    input: { reference: "session", force: true },
    assert: [
      hasObserved<CleanupContext, CleanupAgentSessionResult>("cleanup", {
        disposition: "retained",
        reason: "worktree_removal_failed",
      }),
      hasObserved<CleanupContext, CleanupAgentSessionResult>("deleted", false),
    ],
  },
  {
    name: "reports failed cleanup and restores the remote",
    fixture: "failed",
    input: { reference: "session", force: true },
    assert: [
      hasObserved<CleanupContext, CleanupAgentSessionResult>("cleanup", {
        disposition: "failed",
        reason: "worktree_removal_failed",
      }),
      hasObserved<CleanupContext, CleanupAgentSessionResult>("restoreCount", 1),
    ],
  },
  {
    name: "cancels cleanup without archiving resources",
    fixture: "cancelled",
    input: { reference: "session", force: false },
    assert: [
      hasObserved<CleanupContext, CleanupAgentSessionResult>("cleanup", {
        disposition: "retained",
        reason: "cleanup_declined",
      }),
      hasObserved<CleanupContext, CleanupAgentSessionResult>("archiveCount", 0),
    ],
  },
  {
    name: "reports a failed remote restore instead of hiding the cleanup failure",
    fixture: "restore-failed",
    input: { reference: "session", force: true },
    assert: [
      hasObserved<CleanupContext, CleanupAgentSessionResult>("cleanup", {
        disposition: "failed",
        reason: "remote_restore_failed",
      }),
      hasObserved<CleanupContext, CleanupAgentSessionResult>("restoreCount", 1),
      hasObserved<CleanupContext, CleanupAgentSessionResult>("deleted", false),
    ],
  },
  {
    name: "refuses cleanup while the process is alive",
    fixture: "running",
    input: { reference: "session", force: true },
    assert: [
      hasError<CleanupContext, CleanupAgentSessionResult>({ message: "session 'session' is still running (pid 701)" }),
    ],
  },
] satisfies readonly OperationCase<CleanupKey, CleanupInput, CleanupAgentSessionResult, CleanupContext>[];

const cleanupTable: OperationTable<
  LifecycleFixture,
  CleanupKey,
  CleanupInput,
  CleanupAgentSessionResult,
  CleanupContext
> = {
  defaultFixture: () => ({ fixture: createFixture({ session: sessionFixture({ status: "exited" }) }) }),
  fixtures: {
    removed: () => ({ fixture: createFixture({ session: sessionFixture({ status: "exited" }) }) }),
    retained: () => ({
      fixture: createFixture({
        session: sessionFixture({ status: "exited", backendSessionId: "backend-session" }),
        cleanupDisposition: "retained",
      }),
    }),
    failed: () => ({
      fixture: createFixture({
        session: sessionFixture({ status: "exited", backendSessionId: "backend-session" }),
        cleanupDisposition: "failed",
      }),
    }),
    "restore-failed": () => ({
      fixture: createFixture({
        session: sessionFixture({ status: "exited", backendSessionId: "backend-session" }),
        cleanupDisposition: "failed",
        restoreSucceeded: false,
      }),
    }),
    cancelled: () => ({
      fixture: createFixture({
        session: sessionFixture({
          status: "exited",
          useWorktree: true,
          worktreeRoot: "/worktrees",
          worktreePath: "/worktrees/session",
        }),
        confirmCleanup: false,
      }),
    }),
    running: () => ({
      fixture: createFixture({ session: sessionFixture({ status: "exited", executionPid: 701 }), processAlive: true }),
    }),
  },
  cases: cleanupCases,
  execute: (fixture, input) => createCleanupUseCase(fixture).execute({ workspaceScope: "current", ...input }),
  observe: (fixture, result) => ({
    cleanup: result.ok ? result.value.cleanup : undefined,
    archiveCount: fixture.archiveCount,
    restoreCount: fixture.restoreCount,
    deleted: fixture.deleted,
  }),
};

describe("managed agent session lifecycle use cases", () => {
  const register = it as unknown as TestRegistrar;
  runScenarioTable(register, runTable);
  runScenarioTable(register, resumeTable);
  runOperationTable(register, cleanupTable);
});
