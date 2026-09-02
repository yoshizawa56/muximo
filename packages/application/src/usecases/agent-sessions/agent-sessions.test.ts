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
  type AgentExecutionReceipt,
  type AgentExecutionSpec,
  AttachAgentSession,
  type AttachExecutionInput,
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
  receipts: Map<string, AgentExecutionReceipt>;
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
  abortOnClaim: boolean;
  abortOnAbandonedClaim: boolean;
  recoveryAbortController?: AbortController;
  lateAttachment: boolean;
  resumeAbortController?: AbortController;
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
    abortOnClaim?: boolean;
    abortOnAbandonedClaim?: boolean;
    lateAttachment?: boolean;
    dirty?: boolean;
    runWorkspaceInput?: WorkspaceResolutionInput;
  } = {},
): LifecycleFixture {
  const sessions = new Map<string, AgentSessionRecord>();
  if (options.session) sessions.set(options.session.id, options.session);
  return {
    sessions,
    receipts: new Map(),
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
    abortOnClaim: options.abortOnClaim ?? false,
    abortOnAbandonedClaim: options.abortOnAbandonedClaim ?? false,
    lateAttachment: options.lateAttachment ?? false,
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
      if (fixture.abortOnClaim) fixture.resumeAbortController?.abort();
      return true;
    },
    claimAbandonedExecution: async (input: {
      id: AgentSessionId;
      executionId: string;
      expectedExecutionPid: number | null;
      expectedExecutionStartedAt: string | null;
      expectedExecutionOwnerPid: number | null;
      expectedExecutionOwnerStartedAt: string | null;
      updatedAt: string;
    }) => {
      const current = fixture.sessions.get(input.id);
      if (
        !current ||
        current.executionId !== input.executionId ||
        (current.status !== "running" && current.status !== "resuming") ||
        (current.executionPid ?? null) !== input.expectedExecutionPid ||
        (current.executionStartedAt ?? null) !== input.expectedExecutionStartedAt ||
        (current.executionOwnerPid ?? null) !== input.expectedExecutionOwnerPid ||
        (current.executionOwnerStartedAt ?? null) !== input.expectedExecutionOwnerStartedAt
      ) {
        return false;
      }
      fixture.sessions.set(input.id, { ...current, status: "recovering", resuming: false, updatedAt: input.updatedAt });
      if (fixture.abortOnAbandonedClaim) fixture.recoveryAbortController?.abort();
      return true;
    },
    attachExecution: async (input: AttachExecutionInput) => {
      const current = fixture.sessions.get(input.id);
      if (
        !current ||
        current.executionId !== input.executionId ||
        (current.status !== "running" && current.status !== "resuming") ||
        current.executionPid !== undefined ||
        (current.executionOwnerPid ?? null) !== input.expectedExecutionOwnerPid ||
        (current.executionOwnerStartedAt ?? null) !== input.expectedExecutionOwnerStartedAt
      )
        return false;
      fixture.sessions.set(input.id, {
        ...current,
        executionPid: input.executionPid,
        executionStartedAt: input.executionStartedAt,
        updatedAt: input.updatedAt,
      });
      return true;
    },
    delete: async (id: AgentSessionId) => {
      fixture.sessions.delete(id);
      fixture.deleted = true;
    },
    findExecutionReceipt: async (executionId: string) => fixture.receipts.get(executionId),
    saveExecutionReceipt: async (receipt: AgentExecutionReceipt) => {
      fixture.receipts.set(receipt.executionId, receipt);
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
    prepareLaunch: async (session: AgentSessionRecord) => {
      if (fixture.prepareError) throw fixture.prepareError;
      return {
        execution: {
          sessionId: session.id,
          executionId: session.executionId ?? "execution-id",
          sessionName: session.name,
          backend: session.backend,
          command: ["agent"],
          cwd: session.workspaceRoot,
          environment: {},
        } satisfies AgentExecutionSpec,
      };
    },
    startLaunch: async () => undefined,
    completeLaunch: async () => {
      fixture.runCount += 1;
      try {
        if (fixture.processError) throw fixture.processError;
        const sessionUpdate = fixture.provideBackendSessionId
          ? ({ backendSessionId: "backend-session" } satisfies SessionIdentityUpdate)
          : undefined;
        if (sessionUpdate) fixture.providerUpdates.push(sessionUpdate);
        return sessionUpdate;
      } finally {
        fixture.disposeCount += 1;
      }
    },
    disposeLaunch: async () => undefined,
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
    process: { observe: async () => (fixture.processAlive ? "alive" : "dead") },
  });
}

function createResumeUseCase(fixture: LifecycleFixture): ResumeAgentSession {
  const sessions = repository(fixture);
  const backend = {
    captureBaseline: async () => ({ success: true }),
    prepareLaunch: async (session: AgentSessionRecord) => ({
      execution: {
        sessionId: session.id,
        executionId: session.executionId ?? "execution-id",
        sessionName: session.name,
        backend: session.backend,
        command: ["agent"],
        cwd: session.workspaceRoot,
        environment: {},
      },
    }),
    startLaunch: async () => undefined,
    completeLaunch: async () => {
      fixture.runCount += 1;
      try {
        if (fixture.processError) throw fixture.processError;
        return undefined;
      } finally {
        fixture.disposeCount += 1;
      }
    },
    disposeLaunch: async () => undefined,
  };
  return new ResumeAgentSession({
    sessions,
    locator: new LocateAgentSession({
      sessions,
      workspace: { resolveCurrent: async () => fixture.workspace },
    }),
    process: { observe: async () => (fixture.processAlive ? "alive" : "dead") },
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
  });
}

function createAttachUseCase(fixture: LifecycleFixture): AttachAgentSession {
  const sessions = repository(fixture);
  const launcher = {
    captureBaseline: async () => ({ success: true }),
    prepareLaunch: async (session: AgentSessionRecord) => ({
      execution: {
        sessionId: session.id,
        executionId: session.executionId ?? "execution-id",
        sessionName: session.name,
        backend: session.backend,
        command: ["agent"],
        cwd: session.workspaceRoot,
        environment: {},
      } satisfies AgentExecutionSpec,
    }),
    startLaunch: async () => undefined,
    completeLaunch: async () => undefined,
    disposeLaunch: async () => undefined,
  };
  return new AttachAgentSession({
    sessions,
    launcher,
    panes: {
      adopt: async (_session, hostPaneId) => {
        fixture.adoptCount += 1;
        fixture.adoptedPaneId = hostPaneId;
      },
      release: async () => undefined,
      publish: async () => undefined,
    },
    clock: clock(),
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
    process: { observe: async () => (fixture.processAlive ? "alive" : "dead") },
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
  | "resolution-input"
  | "completion-retry"
  | "abandoned-preparation"
  | "abandoned-execution"
  | "abandoned-recovery-failed"
  | "abandoned-recovery-cancelled"
  | "late-attachment"
  | "preparing";
type RunStep = { operation: "run"; repeat?: number };
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
      hasObserved<RunContext, RunAgentSessionResult>("status", "exited"),
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
      hasObserved<RunContext, RunAgentSessionResult>("processCode", 127),
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
  {
    name: "replays a completed run from its durable receipt without repeating side effects",
    fixture: "completion-retry",
    steps: [{ operation: "run", repeat: 2 }],
    assert: [
      hasObserved<RunContext, RunAgentSessionResult>("status", "exited"),
      hasObserved<RunContext, RunAgentSessionResult>("runCount", 1),
      hasObserved<RunContext, RunAgentSessionResult>("disposeCount", 1),
    ],
  },
  {
    name: "does not recover an owner-only execution without a recorded provider process",
    fixture: "abandoned-preparation",
    steps: [{ operation: "run" }],
    assert: [
      hasError<RunContext, RunAgentSessionResult>({
        message: "session name already exists in this workspace: session",
      }),
    ],
  },
  {
    name: "does not recover a preparation while its CLI owner is alive",
    fixture: "preparing",
    steps: [{ operation: "run" }],
    assert: [
      hasError<RunContext, RunAgentSessionResult>({
        message: "session name already exists in this workspace: session",
      }),
    ],
  },
  {
    name: "recovers an attached execution after both the provider and CLI have exited",
    fixture: "abandoned-execution",
    steps: [{ operation: "run" }],
    assert: [
      hasObserved<RunContext, RunAgentSessionResult>("status", "exited"),
      hasObserved<RunContext, RunAgentSessionResult>("deleted", true),
      hasObserved<RunContext, RunAgentSessionResult>("worktreeRemoveCount", 1),
    ],
  },
  {
    name: "clears the recovery claim when abandoned-session cleanup fails",
    fixture: "abandoned-recovery-failed",
    steps: [{ operation: "run" }],
    assert: [
      hasError<RunContext, RunAgentSessionResult>({ message: /could not be cleaned up/ }),
      hasObserved<RunContext, RunAgentSessionResult>("status", "exited"),
    ],
  },
  {
    name: "finishes abandoned-session recovery before honoring cancellation",
    fixture: "abandoned-recovery-cancelled",
    steps: [{ operation: "run" }],
    assert: [
      hasError<RunContext, RunAgentSessionResult>({ message: /aborted|cancelled/i }),
      hasObserved<RunContext, RunAgentSessionResult>("status", undefined),
    ],
  },
  {
    name: "ignores a delayed attachment after completion has removed the session",
    fixture: "late-attachment",
    steps: [{ operation: "run" }],
    assert: [
      hasObserved<RunContext, RunAgentSessionResult>("status", undefined),
      hasObserved<RunContext, RunAgentSessionResult>("deleted", true),
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
        processResult: {
          started: false,
          code: 127,
          interrupted: false,
          failureDiagnostic: "backend process failed",
        },
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
    "completion-retry": () => ({ fixture: createFixture() }),
    "resolution-input": () => ({
      fixture: createFixture({
        runWorkspaceInput: { workspace: "selected", cwd: "/caller/worktree" },
      }),
    }),
    "abandoned-preparation": () => ({
      fixture: createFixture({
        session: sessionFixture({
          status: "running",
          executionId: "abandoned-execution",
          executionStartedAt: "2026-08-23T00:00:00.000Z",
          executionOwnerPid: 701,
          executionOwnerStartedAt: "2026-08-23T00:00:00.000Z",
        }),
      }),
    }),
    preparing: () => ({
      fixture: createFixture({
        session: sessionFixture({
          status: "running",
          executionId: "active-execution",
          executionStartedAt: "2026-08-23T00:00:00.000Z",
          executionOwnerPid: 701,
          executionOwnerStartedAt: "2026-08-23T00:00:00.000Z",
        }),
        processAlive: true,
      }),
    }),
    "abandoned-execution": () => ({
      fixture: createFixture({
        session: sessionFixture({
          status: "running",
          executionId: "abandoned-execution",
          executionPid: 701,
          executionStartedAt: "2026-08-23T00:00:00.000Z",
          executionOwnerPid: 702,
          executionOwnerStartedAt: "2026-08-23T00:00:00.000Z",
        }),
      }),
    }),
    "abandoned-recovery-failed": () => ({
      fixture: createFixture({
        cleanupDisposition: "retained",
        session: sessionFixture({
          status: "running",
          executionId: "abandoned-recovery-failed",
          executionPid: 701,
          executionStartedAt: "2026-08-23T00:00:00.000Z",
          executionOwnerPid: 702,
          executionOwnerStartedAt: "2026-08-23T00:00:00.000Z",
        }),
      }),
    }),
    "abandoned-recovery-cancelled": () => ({
      fixture: createFixture({
        abortOnAbandonedClaim: true,
        session: sessionFixture({
          status: "running",
          executionId: "abandoned-recovery-cancelled",
          executionPid: 701,
          executionStartedAt: "2026-08-23T00:00:00.000Z",
          executionOwnerPid: 702,
          executionOwnerStartedAt: "2026-08-23T00:00:00.000Z",
        }),
      }),
    }),
    "late-attachment": () => ({
      fixture: createFixture({ useWorktree: true, lateAttachment: true }),
    }),
  },
  cases: runCases,
  execute: async (fixture, steps) => {
    if (steps[0]?.operation !== "run") throw new Error("run scenario has no run step");
    const useCase = createRunUseCase(fixture);
    const recoveryAbortController = fixture.abortOnAbandonedClaim ? new AbortController() : undefined;
    fixture.recoveryAbortController = recoveryAbortController;
    const prepared = await useCase.prepare(
      {
        ...runInput,
        ...(fixture.runWorkspaceInput ?? {}),
        useWorktree: fixture.useWorktree,
      },
      recoveryAbortController?.signal,
    );
    await createAttachUseCase(fixture).execute({
      agentSessionId: prepared.session.id,
      executionId: prepared.session.executionId ?? "",
      executionPid: 700,
      executionStartedAt: "2026-08-23T00:01:00.000Z",
      executionOwnerPid: prepared.session.executionOwnerPid,
      executionOwnerStartedAt: prepared.session.executionOwnerStartedAt,
      hostPaneId: "%1",
    });
    let result = await useCase.complete({
      agentSessionId: prepared.session.id,
      executionId: prepared.session.executionId ?? "",
      hostPaneId: "%1",
      process: fixture.processResult,
    });
    for (let attempt = 1; attempt < (steps[0]?.repeat ?? 1); attempt += 1) {
      result = await useCase.complete({
        agentSessionId: prepared.session.id,
        executionId: prepared.session.executionId ?? "",
        hostPaneId: "%1",
        process: fixture.processResult,
      });
    }
    if (fixture.lateAttachment) {
      await createAttachUseCase(fixture).execute({
        agentSessionId: prepared.session.id,
        executionId: prepared.session.executionId ?? "",
        executionPid: 701,
        executionStartedAt: "2026-08-23T00:01:00.000Z",
        hostPaneId: "%1",
      });
    }
    return result;
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

type ResumeKey = "success" | "failed" | "unattached" | "cancelled";
type ResumeStep = { operation: "resume"; attach?: boolean };
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
  {
    name: "refuses to resume while a prepared execution has no attached process",
    fixture: "unattached",
    steps: [{ operation: "resume" }],
    assert: [
      hasError<ResumeContext, ResumeAgentSessionResult>({
        message: "session 'resume' has an active execution that has not attached a process",
      }),
    ],
  },
  {
    name: "clears a resume claim when preparation is cancelled",
    fixture: "cancelled",
    steps: [{ operation: "resume", attach: false }],
    assert: [
      hasError<ResumeContext, ResumeAgentSessionResult>({ message: /aborted/i }),
      hasObserved<ResumeContext, ResumeAgentSessionResult>("status", "exited"),
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
    unattached: () => ({
      fixture: createFixture({
        session: sessionFixture({ name: "resume", status: "running", executionId: "active-execution" }),
      }),
    }),
    cancelled: () => ({
      fixture: createFixture({ session: sessionFixture({ name: "resume" }), abortOnClaim: true }),
    }),
  },
  cases: resumeCases,
  execute: async (fixture, steps) => {
    if (steps[0]?.operation !== "resume") throw new Error("resume scenario has no resume step");
    const useCase = createResumeUseCase(fixture);
    const controller = fixture.abortOnClaim ? new AbortController() : undefined;
    fixture.resumeAbortController = controller;
    const prepared = await useCase.prepare(
      {
        workspaceScope: "current",
        reference: "resume",
        hostPaneId: "%2",
        backendArgs: [],
      },
      controller?.signal,
    );
    if (steps[0]?.attach !== false) {
      await createAttachUseCase(fixture).execute({
        agentSessionId: prepared.session.id,
        executionId: prepared.session.executionId ?? "",
        executionPid: 700,
        executionStartedAt: "2026-08-23T00:01:00.000Z",
        hostPaneId: "%2",
      });
    }
    return useCase.complete({
      agentSessionId: prepared.session.id,
      executionId: prepared.session.executionId ?? "",
      hostPaneId: "%2",
      process: fixture.processResult,
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

type CleanupKey = "removed" | "retained" | "failed" | "restore-failed" | "cancelled" | "running" | "unattached";
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
  {
    name: "refuses cleanup while a prepared execution has no attached process",
    fixture: "unattached",
    input: { reference: "session", force: true },
    assert: [
      hasError<CleanupContext, CleanupAgentSessionResult>({
        message: "session 'session' has an active execution that has not attached a process",
      }),
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
    unattached: () => ({
      fixture: createFixture({ session: sessionFixture({ status: "running", executionId: "active-execution" }) }),
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
