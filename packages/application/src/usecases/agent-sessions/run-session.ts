import { AgentSession, AgentSessionId, type AgentSessionUpdateInput, clearPatch } from "@muximo/domain";
import { Cause, Effect } from "effect";
import { attemptSync } from "../../attempt.js";
import type {
  AgentExecutionReceipt,
  CleanupResult,
  CompleteAgentSessionInput,
  RunAgentSessionResult,
  SessionIdentityUpdate,
  StartAgentSessionInput,
} from "../../ports/agent-sessions.js";
import { ApplicationFailure } from "../../ports/application.js";
import {
  type AgentSessionServices,
  HookService,
  ManagedAgentSessionRepositoryService,
  PanePublicationService,
  ProcessObservationService,
  RemoteSessionService,
  SessionAuditService,
  SessionCleanupConfirmationService,
  SessionClockService,
  SessionLauncherService,
  SessionLoggerService,
  SessionNamingService,
  SessionResourceService,
  WorkspaceResolverService,
  WorktreeService,
} from "./agent-session-services.js";
import { checkAborted, updateAgentSession } from "./session-updates.js";

/** Prepares, completes, and optionally removes one host-owned agent session. */
export class RunAgentSession {
  private readonly completions = new Map<string, Effect.Effect<RunAgentSessionResult, Error, AgentSessionServices>>();
  private readonly preparing = new Set<string>();
  private readonly recovering = new Set<string>();
  private readonly recoveringExecutions = new Set<string>();

  public readonly prepare = Effect.fn("AgentSessions.prepare")(
    { self: this },
    function* (this: RunAgentSession, input: StartAgentSessionInput, signal?: AbortSignal) {
      const self = this;
      const loggerService = yield* SessionLoggerService;
      const workspaceResolver = yield* WorkspaceResolverService;
      const naming = yield* SessionNamingService;
      const sessions = yield* ManagedAgentSessionRepositoryService;
      const hooks = yield* HookService;
      const worktrees = yield* WorktreeService;
      const clock = yield* SessionClockService;
      const audit = yield* SessionAuditService;
      const launcher = yield* SessionLauncherService;
      yield* checkAborted(signal);
      const logger = loggerService.child({ operation: "run", backend: input.backend });
      logger.debug("session.starting", {
        useWorktree: input.useWorktree,
        backendArgumentCount: input.backendArgs.length,
      });

      const workspace = yield* workspaceResolver.resolveCurrent({ workspace: input.workspace, cwd: input.cwd });
      yield* checkAborted(signal);
      const resolvedName = yield* naming.resolveName(workspace.id, input.name, input.backend);
      const name = yield* attemptSync(() => AgentSession.normalizeName(resolvedName));
      yield* checkAborted(signal);
      const existing = yield* sessions.findByName(workspace.id, name);
      if (existing && !(yield* self.recoverAbandonedExecution(existing, signal))) {
        return yield* Effect.fail(
          new ApplicationFailure("agent_session_name_exists", `session name already exists in this workspace: ${name}`),
        );
      }
      yield* checkAborted(signal);

      const setupHook = input.setupHookExplicit
        ? input.setupHook === undefined
          ? undefined
          : yield* hooks.resolveHook(input.setupHook, workspace.rootPath)
        : input.useWorktree
          ? yield* hooks.resolveStoredHook(workspace.setupScriptPath)
          : undefined;
      const cleanupHook = input.cleanupHookExplicit
        ? input.cleanupHook === undefined
          ? undefined
          : yield* hooks.resolveHook(input.cleanupHook, workspace.rootPath)
        : input.useWorktree
          ? yield* hooks.resolveStoredHook(workspace.cleanupScriptPath)
          : undefined;
      yield* checkAborted(signal);
      let session: AgentSession | undefined;
      let inserted = false;
      let launchPrepared = false;
      const body = Effect.gen(function* () {
        const worktree = input.useWorktree ? yield* worktrees.create(workspace, name, input.worktreeRoot) : {};
        yield* checkAborted(signal);
        const now = clock.now();
        session = yield* attemptSync(() =>
          AgentSession.create({
            id: AgentSessionId.create(clock.id()),
            name,
            backend: input.backend,
            status: "starting",
            workspaceId: workspace.id,
            workspaceRoot: workspace.rootPath,
            workspaceName: workspace.name,
            ...worktree,
            useWorktree: input.useWorktree,
            ...(setupHook === undefined ? {} : { setupHook }),
            ...(cleanupHook === undefined ? {} : { cleanupHook }),
            setupRan: false,
            resuming: false,
            executionId: clock.id(),
            executionStartedAt: now,
            ...(input.executionOwnerPid === undefined
              ? {}
              : { executionOwnerPid: input.executionOwnerPid, executionOwnerStartedAt: now }),
            lastActivityAt: now,
          }),
        );

        yield* sessions.insert(session);
        inserted = true;
        self.preparing.add(session.id);
        yield* checkAborted(signal);
        yield* audit.record("agent_session.created", session.id, {
          name: session.name,
          backend: session.backend,
          workspace: session.workspaceRoot,
        });

        session = yield* self.persist(session, { status: "setup" });
        yield* checkAborted(signal);
        if (!(yield* worktrees.copyFiles(session))) {
          yield* self.markSetupFailed(session);
          return yield* Effect.fail(new ApplicationFailure("worktree_file_copy_failed", "worktree file copy failed"));
        }
        yield* checkAborted(signal);

        const setup = yield* hooks.run(session, "setup");
        yield* checkAborted(signal);
        session = yield* self.persistHookUpdate(session, setup.sessionUpdate);
        if (!setup.success) {
          yield* self.markSetupFailed(session);
          return yield* Effect.fail(new ApplicationFailure("setup_hook_failed", "setup hook failed"));
        }

        session = yield* self.persist(session, {
          setupRan: Boolean(session.setupHook),
          ...(session.useWorktree ? { baselineStatus: "" } : {}),
          status: "ready",
        });
        yield* checkAborted(signal);
        const baseline = yield* launcher.captureBaseline(session);
        yield* checkAborted(signal);
        if (!baseline.success) {
          yield* self.markSetupFailed(session);
          return yield* Effect.fail(
            new ApplicationFailure("backend_baseline_capture_failed", "backend rollout baseline capture failed"),
          );
        }

        session = yield* self.persist(session, { status: "running", backendSessionId: clearPatch });
        yield* checkAborted(signal);
        const preparation = yield* launcher.prepareLaunch(session, input.backendArgs, false, signal);
        launchPrepared = true;
        yield* checkAborted(signal);
        session = yield* self.persistIdentityUpdate(session, preparation.sessionUpdate);
        yield* checkAborted(signal);
        return { session, execution: preparation.execution };
      });
      return yield* body.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (session && inserted) yield* self.cleanupFailedStartup(session, launchPrepared);
            logger.debug("session.failed", { message: Cause.pretty(cause) });
            return yield* Effect.failCause(cause);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (session) self.preparing.delete(session.id);
          }),
        ),
      );
    },
  );

  private readonly recoverAbandonedExecution = Effect.fn("AgentSessions.recoverAbandoned")(
    { self: this },
    function* (this: RunAgentSession, session: AgentSession, signal?: AbortSignal) {
      const processObservation = yield* ProcessObservationService;
      const clock = yield* SessionClockService;
      const sessions = yield* ManagedAgentSessionRepositoryService;
      const logger = yield* SessionLoggerService;
      const launcher = yield* SessionLauncherService;
      const self = this;
      yield* checkAborted(signal);
      if (
        session.status === "interrupted" ||
        session.status === "exited" ||
        session.executionId === undefined ||
        session.executionPid === undefined ||
        session.executionStartedAt === undefined ||
        (session.executionOwnerPid !== undefined && session.executionOwnerStartedAt === undefined)
      ) {
        return false;
      }
      if (this.preparing.has(session.id)) {
        return yield* Effect.fail(
          new ApplicationFailure("agent_session_being_prepared", `session '${session.name}' is still being prepared`),
        );
      }
      if (this.recovering.has(session.id)) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "agent_session_being_recovered",
            `session '${session.name}' is already being recovered`,
          ),
        );
      }
      if (this.completions.has(session.executionId)) {
        return yield* Effect.fail(
          new ApplicationFailure("agent_session_being_finalized", `session '${session.name}' is being finalized`),
        );
      }
      const providerLiveness = yield* processObservation.observe(session.executionPid, session.executionStartedAt);
      const ownerLiveness =
        session.executionOwnerPid === undefined
          ? "dead"
          : yield* processObservation.observe(session.executionOwnerPid, session.executionOwnerStartedAt);
      yield* checkAborted(signal);
      if (providerLiveness !== "dead" || ownerLiveness !== "dead") {
        return false;
      }
      // A completion may have started while the process observations were in
      // flight. Do not claim a record that completion is already finalizing.
      if (this.completions.has(session.executionId)) {
        return false;
      }

      this.recovering.add(session.id);
      this.recoveringExecutions.add(session.executionId);
      let claimed = false;
      const executionId = session.executionId;
      const executionPid = session.executionPid;
      const executionStartedAt = session.executionStartedAt;
      const body = Effect.gen(function* () {
        const recoveringSession = yield* attemptSync(() =>
          session.update({
            status: "recovering",
            resuming: false,
            lastActivityAt: clock.now(),
          }),
        );
        claimed = yield* sessions.claimAbandonedExecution({
          id: session.id,
          executionId,
          expectedExecutionPid: executionPid,
          expectedExecutionStartedAt: executionStartedAt,
          expectedExecutionOwnerPid: session.executionOwnerPid ?? null,
          expectedExecutionOwnerStartedAt: session.executionOwnerStartedAt ?? null,
          lastActivityAt: clock.now(),
        });
        if (!claimed) return false;
        // Once recovery is claimed in the database, finish it even if the
        // caller's preparation signal is cancelled. Leaving the record in
        // `recovering` would permanently block the session name.
        logger.debug("session.abandoned_execution_recovering", {
          sessionId: session.id,
          sessionName: session.name,
          executionId,
          executionPid: session.executionPid,
          executionOwnerPid: session.executionOwnerPid,
        });
        yield* launcher.disposeLaunch(recoveringSession).pipe(
          Effect.catch((error) => {
            logger.debug("session.abandoned_execution_disposal_failed", {
              sessionId: session.id,
              message: errorMessage(error),
            });
            return Effect.fail(
              new ApplicationFailure(
                "abandoned_release_failed",
                `abandoned session '${recoveringSession.name}' could not release its backend resources`,
                { cause: error },
              ),
            );
          }),
        );

        const failed = yield* self.persist(recoveringSession, {
          status: "exited",
          lastExitStatus: 130,
          executionId: clearPatch,
          executionPid: clearPatch,
          executionStartedAt: clearPatch,
          executionOwnerPid: clearPatch,
          executionOwnerStartedAt: clearPatch,
        });
        const cleanup = yield* self.removeResources(failed, true, Boolean(failed.backendSessionId));
        if (cleanup.disposition !== "removed") {
          return yield* Effect.fail(
            new ApplicationFailure(
              "abandoned_cleanup_failed",
              `abandoned session '${failed.name}' could not be cleaned up: ${cleanup.reason}`,
            ),
          );
        }
        return true;
      });
      return yield* body.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (claimed)
              yield* self.markExecutionFailed(
                yield* attemptSync(() =>
                  session.update({
                    status: "recovering",
                    resuming: false,
                    lastActivityAt: clock.now(),
                  }),
                ),
              );
            return yield* Effect.failCause(cause);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            self.recovering.delete(session.id);
            self.recoveringExecutions.delete(executionId);
          }),
        ),
      );
    },
  );

  public readonly complete = Effect.fn("AgentSessions.completeRun")(
    { self: this },
    function* (this: RunAgentSession, input: CompleteAgentSessionInput) {
      const inFlight = this.completions.get(input.executionId);
      if (inFlight) return yield* inFlight;
      const completion = this.completeOnce(input).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (this.completions.get(input.executionId) === completion) this.completions.delete(input.executionId);
          }),
        ),
      );
      this.completions.set(input.executionId, completion);
      return yield* completion;
    },
  );

  private readonly completeOnce = Effect.fn("AgentSessions.completeRunOnce")(
    { self: this },
    function* (this: RunAgentSession, input: CompleteAgentSessionInput) {
      const sessions = yield* ManagedAgentSessionRepositoryService;
      const launcher = yield* SessionLauncherService;
      const panes = yield* PanePublicationService;
      const logger = yield* SessionLoggerService;
      const self = this;
      if (this.recoveringExecutions.has(input.executionId)) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "agent_execution_being_recovered",
            `agent execution '${input.executionId}' is being recovered`,
          ),
        );
      }
      const receipt = yield* sessions.findExecutionReceipt(input.executionId);
      if (receipt) return yield* this.fromReceipt(receipt, input);

      const completeSessionId = yield* attemptSync(() => AgentSessionId.create(input.agentSessionId));
      let session = yield* sessions
        .findById(completeSessionId)
        .pipe(
          Effect.flatMap((found) =>
            found
              ? Effect.succeed(found)
              : Effect.fail(
                  new ApplicationFailure("agent_session_not_found", `agent session not found: ${input.agentSessionId}`),
                ),
          ),
        );
      if (session.executionId !== input.executionId)
        return yield* Effect.fail(
          new ApplicationFailure("agent_execution_not_current", "agent execution is no longer current"),
        );
      if (session.status !== "running")
        return yield* Effect.fail(
          new ApplicationFailure("agent_session_not_running", `agent session '${session.name}' is not running`),
        );

      const published = Effect.gen(function* () {
        const sessionUpdate = yield* launcher.completeLaunch(session, input.process);
        session = yield* self.persistIdentityUpdate(session, sessionUpdate);
        yield* panes.publish(
          session,
          input.process.interrupted || input.process.code === 130 || input.process.code === 143
            ? "stopped"
            : input.process.code === 0
              ? "completed"
              : "failed",
          input.hostPaneId,
        );
      });
      yield* published.pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* self.markExecutionFailed(session);
            return yield* Effect.fail(error);
          }),
        ),
        Effect.ensuring(Effect.ignore(panes.release(session, input.hostPaneId))),
      );

      const result = yield* self.finalize(session, input.process);
      yield* sessions.saveExecutionReceipt({
        operation: "run",
        agentSessionId: input.agentSessionId,
        executionId: input.executionId,
        process: input.process,
        session: result.session,
        cleanup: result.cleanup,
      });
      logger.debug("session.finished", {
        status: result.session.status,
        cleanup: result.cleanup.disposition,
      });
      return result;
    },
  );

  private fromReceipt(
    receipt: AgentExecutionReceipt,
    input: CompleteAgentSessionInput,
  ): Effect.Effect<RunAgentSessionResult, Error> {
    if (
      receipt.operation !== "run" ||
      receipt.agentSessionId !== input.agentSessionId ||
      receipt.executionId !== input.executionId
    ) {
      return Effect.fail(
        new ApplicationFailure(
          "agent_execution_receipt_mismatch",
          "agent execution receipt does not match the completion request",
        ),
      );
    }
    return Effect.succeed({ process: receipt.process, session: receipt.session, cleanup: receipt.cleanup });
  }

  private readonly finalize = Effect.fn("AgentSessions.finalizeRun")(
    { self: this },
    function* (
      this: RunAgentSession,
      session: AgentSession,
      process: RunAgentSessionResult["process"],
    ): Effect.fn.Return<RunAgentSessionResult, Error, AgentSessionServices> {
      const worktrees = yield* WorktreeService;
      const confirmCleanup = yield* SessionCleanupConfirmationService;
      const next = yield* this.persist(session, {
        lastExitStatus: process.code,
        executionId: clearPatch,
        executionPid: clearPatch,
        executionStartedAt: clearPatch,
        executionOwnerPid: clearPatch,
        executionOwnerStartedAt: clearPatch,
        status: process.interrupted || process.code === 130 || process.code === 143 ? "interrupted" : "exited",
      });
      if (next.status === "interrupted") {
        return { process, session: next, cleanup: { disposition: "not_requested", reason: "interrupted" } };
      }
      if (isStartupFailure(process)) {
        const cleanup = yield* this.removeResources(next, true, Boolean(next.backendSessionId));
        return { process, session: next, cleanup };
      }
      if (!next.useWorktree) {
        return { process, session: next, cleanup: { disposition: "not_requested", reason: "no_worktree" } };
      }

      const dirty = yield* worktrees.hasChanges(next);
      if (!(yield* confirmCleanup.confirm(next, dirty))) {
        return { process, session: next, cleanup: { disposition: "retained", reason: "cleanup_declined" } };
      }
      const cleanup = yield* this.removeResources(next, dirty);
      return { process, session: next, cleanup };
    },
  );

  private readonly removeResources = Effect.fn("AgentSessions.removeRunResources")(
    { self: this },
    function* (
      this: RunAgentSession,
      session: AgentSession,
      force: boolean,
      archiveRemote = true,
    ): Effect.fn.Return<CleanupResult, Error, AgentSessionServices> {
      const remote = yield* RemoteSessionService;
      const hooks = yield* HookService;
      const worktrees = yield* WorktreeService;
      const sessions = yield* ManagedAgentSessionRepositoryService;
      const audit = yield* SessionAuditService;
      const resources = yield* SessionResourceService;
      if (archiveRemote && !(yield* remote.archive(session))) {
        return { disposition: "failed", reason: "remote_archive_failed" };
      }
      const hook = yield* hooks.run(session, "cleanup");
      session = yield* this.persistHookUpdate(session, hook.sessionUpdate);
      if (!hook.success) {
        const restored = !archiveRemote || (yield* remote.restore(session));
        return { disposition: "failed", reason: restored ? "cleanup_hook_failed" : "remote_restore_failed" };
      }
      const worktree = yield* worktrees.remove(session, force);
      if (worktree.disposition !== "removed") {
        const restored = !archiveRemote || (yield* remote.restore(session));
        return restored ? worktree : { disposition: "failed", reason: "remote_restore_failed" };
      }
      yield* sessions.delete(session.id);
      yield* audit.record("agent_session.deleted", session.id, { name: session.name });
      yield* hooks.removeOutputs(session);
      const remaining = yield* sessions.list(session.workspaceId);
      yield* resources.releaseIfUnused(session, remaining);
      return worktree;
    },
  );

  private readonly cleanupFailedStartup = Effect.fn("AgentSessions.cleanupFailedStartup")(
    { self: this },
    function* (this: RunAgentSession, session: AgentSession, launchPrepared: boolean) {
      const launcher = yield* SessionLauncherService;
      const logger = yield* SessionLoggerService;
      const self = this;
      if (launchPrepared) {
        yield* launcher.disposeLaunch(session).pipe(
          Effect.catch((error) => {
            logger.debug("session.startup_launch_cleanup_failed", { message: errorMessage(error) });
            return Effect.succeed(undefined);
          }),
        );
      }

      yield* Effect.gen(function* () {
        const failed = yield* self.persist(session, {
          status: "exited",
          lastExitStatus: 1,
          executionId: clearPatch,
          executionPid: clearPatch,
          executionStartedAt: clearPatch,
          executionOwnerPid: clearPatch,
          executionOwnerStartedAt: clearPatch,
        });
        const cleanup = yield* self.removeResources(failed, true, Boolean(failed.backendSessionId));
        if (cleanup.disposition !== "removed") {
          logger.debug("session.startup_cleanup_failed", { reason: cleanup.reason });
        }
      }).pipe(
        Effect.catch((error) => {
          logger.debug("session.startup_cleanup_failed", { message: errorMessage(error) });
          return Effect.succeed(undefined);
        }),
      );
    },
  );

  private readonly markExecutionFailed = Effect.fn("AgentSessions.markExecutionFailed")(
    { self: this },
    function* (this: RunAgentSession, session: AgentSession) {
      yield* this.persist(session, {
        status: "exited",
        lastExitStatus: 1,
        executionId: clearPatch,
        executionPid: clearPatch,
        executionStartedAt: clearPatch,
        executionOwnerPid: clearPatch,
        executionOwnerStartedAt: clearPatch,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    },
  );

  private readonly persist = Effect.fn("AgentSessions.persistRun")(
    { self: this },
    function* (this: RunAgentSession, session: AgentSession, input: AgentSessionUpdateInput) {
      const sessions = yield* ManagedAgentSessionRepositoryService;
      const next = yield* updateAgentSession(session, input);
      yield* sessions.update(next);
      return next;
    },
  );

  private readonly persistIdentityUpdate = Effect.fn("AgentSessions.persistRunIdentity")(
    { self: this },
    function* (this: RunAgentSession, session: AgentSession, input: SessionIdentityUpdate | undefined) {
      return input?.backendSessionId === undefined
        ? session
        : yield* this.persist(session, { backendSessionId: input.backendSessionId });
    },
  );

  private readonly persistHookUpdate = Effect.fn("AgentSessions.persistRunHook")(
    { self: this },
    function* (
      this: RunAgentSession,
      session: AgentSession,
      input: import("../../ports/agent-sessions.js").HookSessionUpdate | undefined,
    ) {
      if (!input) return session;
      return yield* this.persist(session, input);
    },
  );

  private readonly markSetupFailed = Effect.fn("AgentSessions.markSetupFailed")(
    { self: this },
    function* (this: RunAgentSession, session: AgentSession) {
      yield* this.persist(session, { status: "setup_failed" });
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStartupFailure(process: RunAgentSessionResult["process"]): boolean {
  return !process.interrupted && !process.started && process.code !== 0;
}
