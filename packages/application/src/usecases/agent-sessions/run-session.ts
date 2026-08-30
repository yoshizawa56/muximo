import { AgentSession, AgentSessionId, type AgentSessionRecord, clearPatch } from "@muximo/domain";
import type {
  AgentExecutionReceipt,
  CleanupResult,
  CompleteAgentSessionInput,
  HookPort,
  ManagedAgentSessionRepository,
  PanePublicationPort,
  PreparedAgentSession,
  RemoteSessionPort,
  RunAgentSessionResult,
  SessionAuditPort,
  SessionCleanupConfirmationPort,
  SessionClock,
  SessionIdentityUpdate,
  SessionLauncherPort,
  SessionLogger,
  SessionNamingPort,
  SessionResourcePort,
  StartAgentSessionInput,
  WorkspaceResolverPort,
  WorktreePort,
} from "../../ports/agent-sessions.js";
import { updateAgentSession } from "./session-updates.js";

export type RunAgentSessionDependencies = {
  sessions: ManagedAgentSessionRepository;
  workspace: WorkspaceResolverPort;
  naming: SessionNamingPort;
  hooks: HookPort;
  worktrees: WorktreePort;
  launcher: SessionLauncherPort;
  remote: RemoteSessionPort;
  resources: SessionResourcePort;
  panes: PanePublicationPort;
  audit: SessionAuditPort;
  clock: SessionClock;
  logger: SessionLogger;
  confirmCleanup: SessionCleanupConfirmationPort;
};

/** Prepares, completes, and optionally removes one host-owned agent session. */
export class RunAgentSession {
  private readonly completions = new Map<string, Promise<RunAgentSessionResult>>();

  public constructor(private readonly deps: RunAgentSessionDependencies) {}

  public async prepare(input: StartAgentSessionInput): Promise<PreparedAgentSession> {
    const logger = this.deps.logger.child({ operation: "run", backend: input.backend });
    logger.debug("session.starting", {
      useWorktree: input.useWorktree,
      backendArgumentCount: input.backendArgs.length,
    });

    const workspace = await this.deps.workspace.resolveCurrent({ workspace: input.workspace, cwd: input.cwd });
    const name = AgentSession.normalizeName(
      await this.deps.naming.resolveName(workspace.id, input.name, input.backend),
    );
    if ((await this.deps.sessions.list(workspace.id)).some((candidate) => candidate.name === name)) {
      throw new Error(`session name already exists in this workspace: ${name}`);
    }

    const setupHook = input.setupHookExplicit
      ? input.setupHook === undefined
        ? undefined
        : await this.deps.hooks.resolveHook(input.setupHook, workspace.rootPath)
      : input.useWorktree
        ? await this.deps.hooks.resolveStoredHook(workspace.setupScriptPath)
        : undefined;
    const cleanupHook = input.cleanupHookExplicit
      ? input.cleanupHook === undefined
        ? undefined
        : await this.deps.hooks.resolveHook(input.cleanupHook, workspace.rootPath)
      : input.useWorktree
        ? await this.deps.hooks.resolveStoredHook(workspace.cleanupScriptPath)
        : undefined;
    let session: AgentSessionRecord | undefined;
    let inserted = false;
    let launchPrepared = false;
    try {
      const worktree = input.useWorktree ? await this.deps.worktrees.create(workspace, name, input.worktreeRoot) : {};
      const now = this.deps.clock.now();
      session = AgentSession.create({
        id: AgentSessionId.create(this.deps.clock.id()),
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
        executionId: this.deps.clock.id(),
        executionStartedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await this.deps.sessions.insert(session);
      inserted = true;
      await this.deps.audit.record("agent_session.created", session.id, {
        name: session.name,
        backend: session.backend,
        workspace: session.workspaceRoot,
      });

      session = await this.persist(session, { status: "setup" });
      if (!(await this.deps.worktrees.copyFiles(session))) {
        await this.markSetupFailed(session);
        throw new Error("worktree file copy failed");
      }

      const setup = await this.deps.hooks.run(session, "setup");
      session = await this.persistHookUpdate(session, setup.sessionUpdate);
      if (!setup.success) {
        await this.markSetupFailed(session);
        throw new Error("setup hook failed");
      }

      session = await this.persist(session, {
        setupRan: Boolean(session.setupHook),
        ...(session.useWorktree ? { baselineStatus: "" } : {}),
        status: "ready",
      });
      const baseline = await this.deps.launcher.captureBaseline(session);
      if (!baseline.success) {
        await this.markSetupFailed(session);
        throw new Error("backend rollout baseline capture failed");
      }

      session = await this.persist(session, { status: "running", backendSessionId: clearPatch });
      const preparation = await this.deps.launcher.prepareLaunch(session, input.backendArgs, false);
      launchPrepared = true;
      session = await this.persistIdentityUpdate(session, preparation.sessionUpdate);
      return { session, execution: preparation.execution };
    } catch (error) {
      if (session && inserted) await this.cleanupFailedStartup(session, launchPrepared);
      logger.debug("session.failed", { message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  public complete(input: CompleteAgentSessionInput): Promise<RunAgentSessionResult> {
    const inFlight = this.completions.get(input.executionId);
    if (inFlight) return inFlight;
    const completion = this.completeOnce(input);
    this.completions.set(input.executionId, completion);
    const clearCompletion = () => {
      if (this.completions.get(input.executionId) === completion) this.completions.delete(input.executionId);
    };
    void completion.then(clearCompletion, clearCompletion);
    return completion;
  }

  private async completeOnce(input: CompleteAgentSessionInput): Promise<RunAgentSessionResult> {
    const receipt = await this.deps.sessions.findExecutionReceipt(input.executionId);
    if (receipt) return this.fromReceipt(receipt, input);

    let session = await this.deps.sessions.findById(AgentSessionId.create(input.agentSessionId));
    if (!session) throw new Error(`agent session not found: ${input.agentSessionId}`);
    if (session.executionId !== input.executionId) throw new Error("agent execution is no longer current");
    if (session.status !== "running") throw new Error(`agent session '${session.name}' is not running`);

    try {
      const sessionUpdate = await this.deps.launcher.completeLaunch(session, input.process);
      session = await this.persistIdentityUpdate(session, sessionUpdate);
      await this.deps.panes.publish(
        session,
        input.process.interrupted || input.process.code === 130 || input.process.code === 143
          ? "stopped"
          : input.process.code === 0
            ? "completed"
            : "failed",
        input.hostPaneId,
      );
    } catch (error) {
      await this.markExecutionFailed(session);
      throw error;
    } finally {
      await this.deps.panes.release(session, input.hostPaneId);
    }

    const result = await this.finalize(session, input.process);
    await this.deps.sessions.saveExecutionReceipt({
      operation: "run",
      agentSessionId: input.agentSessionId,
      executionId: input.executionId,
      process: input.process,
      session: result.session,
      cleanup: result.cleanup,
    });
    this.deps.logger.debug("session.finished", { status: result.session.status, cleanup: result.cleanup.disposition });
    return result;
  }

  private fromReceipt(receipt: AgentExecutionReceipt, input: CompleteAgentSessionInput): RunAgentSessionResult {
    if (
      receipt.operation !== "run" ||
      receipt.agentSessionId !== input.agentSessionId ||
      receipt.executionId !== input.executionId
    ) {
      throw new Error("agent execution receipt does not match the completion request");
    }
    return { process: receipt.process, session: receipt.session, cleanup: receipt.cleanup };
  }

  private async finalize(
    session: AgentSessionRecord,
    process: RunAgentSessionResult["process"],
  ): Promise<RunAgentSessionResult> {
    const next = await this.persist(session, {
      lastExitStatus: process.code,
      executionId: clearPatch,
      executionPid: clearPatch,
      executionStartedAt: clearPatch,
      status: process.interrupted || process.code === 130 || process.code === 143 ? "interrupted" : "exited",
    });
    if (next.status === "interrupted") {
      return { process, session: next, cleanup: { disposition: "not_requested", reason: "interrupted" } };
    }
    if (isStartupFailure(process)) {
      const cleanup = await this.removeResources(next, true, Boolean(next.backendSessionId));
      return { process, session: next, cleanup };
    }
    if (!next.useWorktree) {
      return { process, session: next, cleanup: { disposition: "not_requested", reason: "no_worktree" } };
    }

    const dirty = await this.deps.worktrees.hasChanges(next);
    if (!(await this.deps.confirmCleanup.confirm(next, dirty))) {
      return { process, session: next, cleanup: { disposition: "retained", reason: "cleanup_declined" } };
    }
    const cleanup = await this.removeResources(next, dirty);
    return { process, session: next, cleanup };
  }

  private async removeResources(
    session: AgentSessionRecord,
    force: boolean,
    archiveRemote = true,
  ): Promise<CleanupResult> {
    if (archiveRemote && !(await this.deps.remote.archive(session))) {
      return { disposition: "failed", reason: "remote_archive_failed" };
    }
    const hook = await this.deps.hooks.run(session, "cleanup");
    session = await this.persistHookUpdate(session, hook.sessionUpdate);
    if (!hook.success) {
      const restored = !archiveRemote || (await this.deps.remote.restore(session));
      return { disposition: "failed", reason: restored ? "cleanup_hook_failed" : "remote_restore_failed" };
    }
    const worktree = await this.deps.worktrees.remove(session, force);
    if (worktree.disposition !== "removed") {
      const restored = !archiveRemote || (await this.deps.remote.restore(session));
      return restored ? worktree : { disposition: "failed", reason: "remote_restore_failed" };
    }
    await this.deps.sessions.delete(session.id);
    await this.deps.audit.record("agent_session.deleted", session.id, { name: session.name });
    await this.deps.hooks.removeOutputs(session);
    const remaining = await this.deps.sessions.list(session.workspaceId);
    await this.deps.resources.releaseIfUnused(session, remaining);
    return worktree;
  }

  private async cleanupFailedStartup(session: AgentSessionRecord, launchPrepared: boolean): Promise<void> {
    if (launchPrepared) {
      try {
        await this.deps.launcher.disposeLaunch(session);
      } catch (error) {
        this.deps.logger.debug("session.startup_launch_cleanup_failed", { message: errorMessage(error) });
      }
    }

    try {
      const failed = await this.persist(session, {
        status: "exited",
        lastExitStatus: 1,
        executionId: clearPatch,
        executionPid: clearPatch,
        executionStartedAt: clearPatch,
      });
      const cleanup = await this.removeResources(failed, true, Boolean(failed.backendSessionId));
      if (cleanup.disposition !== "removed") {
        this.deps.logger.debug("session.startup_cleanup_failed", { reason: cleanup.reason });
      }
    } catch (error) {
      this.deps.logger.debug("session.startup_cleanup_failed", { message: errorMessage(error) });
    }
  }

  private async markExecutionFailed(session: AgentSessionRecord): Promise<void> {
    await this.deps.sessions
      .update(
        updateAgentSession(
          session,
          {
            status: "exited",
            lastExitStatus: 1,
            executionId: clearPatch,
            executionPid: clearPatch,
            executionStartedAt: clearPatch,
          },
          this.deps.clock,
        ),
      )
      .catch(() => undefined);
  }

  private async persist(session: AgentSessionRecord, input: Parameters<typeof AgentSession.update>[1]) {
    const next = updateAgentSession(session, input, this.deps.clock);
    await this.deps.sessions.update(next);
    return next;
  }

  private async persistIdentityUpdate(session: AgentSessionRecord, input: SessionIdentityUpdate | undefined) {
    return input?.backendSessionId === undefined
      ? session
      : this.persist(session, { backendSessionId: input.backendSessionId });
  }

  private async persistHookUpdate(
    session: AgentSessionRecord,
    input: import("../../ports/agent-sessions.js").HookSessionUpdate | undefined,
  ) {
    if (!input) return session;
    return this.persist(session, input);
  }

  private async markSetupFailed(session: AgentSessionRecord): Promise<void> {
    await this.persist(session, { status: "setup_failed" });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStartupFailure(process: RunAgentSessionResult["process"]): boolean {
  return !process.interrupted && !process.started && process.code !== 0;
}
