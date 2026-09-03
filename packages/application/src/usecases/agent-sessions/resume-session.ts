import { type AgentSession, AgentSessionId, type AgentSessionUpdateInput, clearPatch } from "@muximo/domain";
import { Effect } from "effect";
import { attemptSync } from "../../attempt.js";
import type {
  AgentExecutionReceipt,
  CompleteAgentSessionInput,
  ManagedAgentSessionRepository,
  PanePublicationPort,
  ProcessObservationPort,
  ResumeAgentSessionInput,
  ResumeAgentSessionResult,
  SessionClock,
  SessionLauncherPort,
  SessionLogger,
} from "../../ports/agent-sessions.js";
import { ApplicationFailure } from "../../ports/application.js";
import type { LocateAgentSession } from "./locate-session.js";
import { checkAborted, updateAgentSession } from "./session-updates.js";

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
  private readonly completions = new Map<string, Effect.Effect<ResumeAgentSessionResult, Error>>();

  public constructor(private readonly deps: ResumeAgentSessionDependencies) {}

  public readonly prepare = Effect.fn("AgentSessions.prepareResume")(
    { self: this },
    function* (this: ResumeAgentSession, input: ResumeAgentSessionInput, signal?: AbortSignal) {
      const deps = this.deps;
      const self = this;
      yield* checkAborted(signal);
      let session = yield* deps.locator.execute({
        reference: input.reference,
        workspaceScope: input.workspaceScope,
      });
      yield* checkAborted(signal);
      if (session.status === "setup_failed")
        return yield* Effect.fail(
          new ApplicationFailure(
            "resume_setup_failed",
            `session '${session.name}' has a failed setup; clean it up before retrying`,
          ),
        );
      if (session.status === "recovering")
        return yield* Effect.fail(
          new ApplicationFailure("agent_session_being_recovered", `session '${session.name}' is being recovered`),
        );
      if (session.status === "starting" || session.status === "setup" || session.status === "ready")
        return yield* Effect.fail(
          new ApplicationFailure(
            "resume_backend_not_started",
            `session '${session.name}' has not started its backend; rerun it instead of resuming`,
          ),
        );
      if ((session.status === "running" || session.status === "resuming") && session.executionPid === undefined) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "resume_execution_unattached",
            `session '${session.name}' has an active execution that has not attached a process`,
          ),
        );
      }
      if (session.executionPid !== undefined) {
        const providerLiveness = yield* deps.process.observe(session.executionPid, session.executionStartedAt);
        if (providerLiveness === "alive") {
          return yield* Effect.fail(
            new ApplicationFailure(
              "resume_already_running",
              `session '${session.name}' is already running (pid ${session.executionPid})`,
            ),
          );
        }
        if (providerLiveness === "unknown") {
          return yield* Effect.fail(
            new ApplicationFailure(
              "agent_session_liveness_unverifiable",
              `could not verify whether session '${session.name}' is still running`,
            ),
          );
        }
      }
      if (session.executionOwnerPid !== undefined) {
        const ownerLiveness = yield* deps.process.observe(session.executionOwnerPid, session.executionOwnerStartedAt);
        if (ownerLiveness === "alive") {
          return yield* Effect.fail(
            new ApplicationFailure(
              "resume_owned_by_cli",
              `session '${session.name}' is still owned by its CLI process (pid ${session.executionOwnerPid})`,
            ),
          );
        }
        if (ownerLiveness === "unknown") {
          return yield* Effect.fail(
            new ApplicationFailure(
              "resume_owner_unverifiable",
              `could not verify whether session '${session.name}' is still owned by its CLI process`,
            ),
          );
        }
      }
      let launchPrepared = false;
      const executionId = deps.clock.id();
      const executionStartedAt = deps.clock.now();
      yield* checkAborted(signal);
      let claimed = false;
      const body = Effect.gen(function* () {
        claimed = yield* deps.sessions.claimExecution({
          id: session.id,
          expectedExecutionPid: session.executionPid ?? null,
          executionId,
          executionPid: null,
          executionStartedAt,
          executionOwnerPid: input.executionOwnerPid ?? null,
          executionOwnerStartedAt: input.executionOwnerPid === undefined ? null : executionStartedAt,
          lastActivityAt: executionStartedAt,
        });
        if (!claimed)
          return yield* Effect.fail(
            new ApplicationFailure(
              "agent_session_already_resuming",
              `session '${session.name}' is already being resumed`,
            ),
          );
        yield* checkAborted(signal);

        session = yield* self.persist(session, {
          status: "resuming",
          resuming: true,
          executionId,
          executionPid: clearPatch,
          executionStartedAt,
          ...(input.executionOwnerPid === undefined
            ? { executionOwnerPid: clearPatch, executionOwnerStartedAt: clearPatch }
            : { executionOwnerPid: input.executionOwnerPid, executionOwnerStartedAt: executionStartedAt }),
        });
        const preparation = yield* deps.launcher.prepareLaunch(session, input.backendArgs, true, signal);
        launchPrepared = true;
        yield* checkAborted(signal);
        session = yield* self.persistIdentityUpdate(session, preparation.sessionUpdate);
        yield* checkAborted(signal);
        return { session, execution: preparation.execution };
      });
      return yield* body.pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (launchPrepared) {
              yield* deps.launcher.disposeLaunch(session).pipe(
                Effect.catch((disposeError) => {
                  deps.logger.debug("session.resume_launch_cleanup_failed", {
                    message: errorMessage(disposeError),
                  });
                  return Effect.succeed(undefined);
                }),
              );
            }
            if (claimed) yield* self.markExecutionFailed(session);
            return yield* Effect.failCause(cause);
          }),
        ),
      );
    },
  );

  public readonly complete = Effect.fn("AgentSessions.completeResume")(
    { self: this },
    function* (this: ResumeAgentSession, input: CompleteAgentSessionInput) {
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

  private readonly completeOnce = Effect.fn("AgentSessions.completeResumeOnce")(
    { self: this },
    function* (this: ResumeAgentSession, input: CompleteAgentSessionInput) {
      const deps = this.deps;
      const self = this;
      const receipt = yield* deps.sessions.findExecutionReceipt(input.executionId);
      if (receipt) return yield* this.fromReceipt(receipt, input);

      const completeSessionId = yield* attemptSync(() => AgentSessionId.create(input.agentSessionId));
      let session = yield* deps.sessions
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
      if (session.status !== "resuming")
        return yield* Effect.fail(
          new ApplicationFailure("agent_session_not_resuming", `agent session '${session.name}' is not resuming`),
        );

      const published = Effect.gen(function* () {
        const sessionUpdate = yield* deps.launcher.completeLaunch(session, input.process);
        session = yield* self.persistIdentityUpdate(session, sessionUpdate);
        yield* deps.panes.publish(
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
        Effect.ensuring(Effect.ignore(deps.panes.release(session, input.hostPaneId))),
      );

      const next = yield* self.persist(session, {
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
      yield* deps.sessions.saveExecutionReceipt({
        operation: "resume",
        agentSessionId: input.agentSessionId,
        executionId: input.executionId,
        process: input.process,
        session: next,
      });
      return { process: input.process, session: next };
    },
  );

  private fromReceipt(
    receipt: AgentExecutionReceipt,
    input: CompleteAgentSessionInput,
  ): Effect.Effect<ResumeAgentSessionResult, Error> {
    if (
      receipt.operation !== "resume" ||
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
    return Effect.succeed({ process: receipt.process, session: receipt.session });
  }

  private readonly persist = Effect.fn("AgentSessions.persistResume")(
    { self: this },
    function* (this: ResumeAgentSession, session: AgentSession, input: AgentSessionUpdateInput) {
      const next = yield* updateAgentSession(session, input, this.deps.clock);
      yield* this.deps.sessions.update(next);
      return next;
    },
  );

  private readonly persistIdentityUpdate = Effect.fn("AgentSessions.persistResumeIdentity")(
    { self: this },
    function* (
      this: ResumeAgentSession,
      session: AgentSession,
      input: import("../../ports/agent-sessions.js").SessionIdentityUpdate | undefined,
    ) {
      return input?.backendSessionId === undefined
        ? session
        : yield* this.persist(session, { backendSessionId: input.backendSessionId });
    },
  );

  private readonly markExecutionFailed = Effect.fn("AgentSessions.markResumeFailed")(
    { self: this },
    function* (this: ResumeAgentSession, session: AgentSession) {
      yield* this.persist(session, {
        status: "exited",
        lastExitStatus: 1,
        executionId: clearPatch,
        executionPid: clearPatch,
        executionStartedAt: clearPatch,
        executionOwnerPid: clearPatch,
        executionOwnerStartedAt: clearPatch,
        resuming: false,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    },
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
