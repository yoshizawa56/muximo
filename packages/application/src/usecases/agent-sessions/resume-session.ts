import { type AgentSession, AgentSessionId, type AgentSessionRecord, clearPatch } from "@muximo/domain";
import type {
  AgentExecutionReceipt,
  CompleteAgentSessionInput,
  ManagedAgentSessionRepository,
  PanePublicationPort,
  PreparedAgentSession,
  ProcessObservationPort,
  ResumeAgentSessionInput,
  ResumeAgentSessionResult,
  SessionClock,
  SessionLauncherPort,
  SessionLogger,
} from "../../ports/agent-sessions.js";
import type { LocateAgentSession } from "./locate-session.js";
import { updateAgentSession } from "./session-updates.js";

export type ResumeAgentSessionDependencies = {
  sessions: ManagedAgentSessionRepository;
  locator: LocateAgentSession;
  process: ProcessObservationPort;
  launcher: SessionLauncherPort;
  panes: PanePublicationPort;
  clock: SessionClock;
  logger: SessionLogger;
};

/** Claims and prepares one persisted agent session for host-owned execution. */
export class ResumeAgentSession {
  private readonly completions = new Map<string, Promise<ResumeAgentSessionResult>>();

  public constructor(private readonly deps: ResumeAgentSessionDependencies) {}

  public async prepare(input: ResumeAgentSessionInput, signal?: AbortSignal): Promise<PreparedAgentSession> {
    throwIfAborted(signal);
    let session = await this.deps.locator.execute({
      reference: input.reference,
      workspaceScope: input.workspaceScope,
    });
    throwIfAborted(signal);
    if (session.status === "setup_failed")
      throw new Error(`session '${session.name}' has a failed setup; clean it up before retrying`);
    if (session.status === "recovering") throw new Error(`session '${session.name}' is being recovered`);
    if (session.status === "starting" || session.status === "setup" || session.status === "ready")
      throw new Error(`session '${session.name}' has not started its backend; rerun it instead of resuming`);
    if ((session.status === "running" || session.status === "resuming") && session.executionPid === undefined) {
      throw new Error(`session '${session.name}' has an active execution that has not attached a process`);
    }
    if (session.executionPid !== undefined) {
      const providerLiveness = await this.deps.process.observe(session.executionPid, session.executionStartedAt);
      if (providerLiveness === "alive") {
        throw new Error(`session '${session.name}' is already running (pid ${session.executionPid})`);
      }
      if (providerLiveness === "unknown") {
        throw new Error(`could not verify whether session '${session.name}' is still running`);
      }
    }
    if (session.executionOwnerPid !== undefined) {
      const ownerLiveness = await this.deps.process.observe(session.executionOwnerPid, session.executionOwnerStartedAt);
      if (ownerLiveness === "alive") {
        throw new Error(
          `session '${session.name}' is still owned by its CLI process (pid ${session.executionOwnerPid})`,
        );
      }
      if (ownerLiveness === "unknown") {
        throw new Error(`could not verify whether session '${session.name}' is still owned by its CLI process`);
      }
    }
    let launchPrepared = false;
    const executionId = this.deps.clock.id();
    const executionStartedAt = this.deps.clock.now();
    throwIfAborted(signal);
    if (
      !(await this.deps.sessions.claimExecution({
        id: session.id,
        expectedExecutionPid: session.executionPid ?? null,
        executionId,
        executionPid: null,
        executionStartedAt,
        executionOwnerPid: input.executionOwnerPid ?? null,
        executionOwnerStartedAt: input.executionOwnerPid === undefined ? null : executionStartedAt,
        updatedAt: executionStartedAt,
      }))
    ) {
      throw new Error(`session '${session.name}' is already being resumed`);
    }
    try {
      throwIfAborted(signal);

      session = await this.persist(session, {
        status: "resuming",
        resuming: true,
        executionId,
        executionPid: clearPatch,
        executionStartedAt,
        ...(input.executionOwnerPid === undefined
          ? { executionOwnerPid: clearPatch, executionOwnerStartedAt: clearPatch }
          : { executionOwnerPid: input.executionOwnerPid, executionOwnerStartedAt: executionStartedAt }),
      });
      const preparation = await this.deps.launcher.prepareLaunch(session, input.backendArgs, true, signal);
      launchPrepared = true;
      throwIfAborted(signal);
      session = await this.persistIdentityUpdate(session, preparation.sessionUpdate);
      throwIfAborted(signal);
      return { session, execution: preparation.execution };
    } catch (error) {
      if (launchPrepared) {
        try {
          await this.deps.launcher.disposeLaunch(session);
        } catch (disposeError) {
          this.deps.logger.debug("session.resume_launch_cleanup_failed", { message: errorMessage(disposeError) });
        }
      }
      await this.markExecutionFailed(session);
      throw error;
    }
  }

  public complete(input: CompleteAgentSessionInput): Promise<ResumeAgentSessionResult> {
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

  private async completeOnce(input: CompleteAgentSessionInput): Promise<ResumeAgentSessionResult> {
    const receipt = await this.deps.sessions.findExecutionReceipt(input.executionId);
    if (receipt) return this.fromReceipt(receipt, input);

    let session = await this.deps.sessions.findById(AgentSessionId.create(input.agentSessionId));
    if (!session) throw new Error(`agent session not found: ${input.agentSessionId}`);
    if (session.executionId !== input.executionId) throw new Error("agent execution is no longer current");
    if (session.status !== "resuming") throw new Error(`agent session '${session.name}' is not resuming`);

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

    const next = await this.persist(session, {
      lastExitStatus: input.process.code,
      executionId: clearPatch,
      executionPid: clearPatch,
      executionStartedAt: clearPatch,
      executionOwnerPid: clearPatch,
      executionOwnerStartedAt: clearPatch,
      status:
        input.process.interrupted || input.process.code === 130 || input.process.code === 143
          ? "interrupted"
          : "exited",
      resuming: false,
    });
    await this.deps.sessions.saveExecutionReceipt({
      operation: "resume",
      agentSessionId: input.agentSessionId,
      executionId: input.executionId,
      process: input.process,
      session: next,
    });
    return { process: input.process, session: next };
  }

  private fromReceipt(receipt: AgentExecutionReceipt, input: CompleteAgentSessionInput): ResumeAgentSessionResult {
    if (
      receipt.operation !== "resume" ||
      receipt.agentSessionId !== input.agentSessionId ||
      receipt.executionId !== input.executionId
    ) {
      throw new Error("agent execution receipt does not match the completion request");
    }
    return { process: receipt.process, session: receipt.session };
  }

  private async persist(
    session: AgentSessionRecord,
    input: Parameters<typeof AgentSession.update>[1],
  ): Promise<AgentSessionRecord> {
    const next = updateAgentSession(session, input, this.deps.clock);
    await this.deps.sessions.update(next);
    return next;
  }

  private async persistIdentityUpdate(
    session: AgentSessionRecord,
    input: import("../../ports/agent-sessions.js").SessionIdentityUpdate | undefined,
  ): Promise<AgentSessionRecord> {
    return input?.backendSessionId === undefined
      ? session
      : this.persist(session, { backendSessionId: input.backendSessionId });
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
            executionOwnerPid: clearPatch,
            executionOwnerStartedAt: clearPatch,
            resuming: false,
          },
          this.deps.clock,
        ),
      )
      .catch(() => undefined);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error("agent execution preparation was cancelled");
}
