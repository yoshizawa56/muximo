import { type AgentSession, type AgentSessionRecord, clearPatch } from "@muximo/domain";
import type {
  LaunchExecution,
  ManagedAgentSessionRepository,
  PanePublicationPort,
  ProcessObservationPort,
  ResumeAgentSessionInput,
  ResumeAgentSessionResult,
  SessionClock,
  SessionIdentityUpdate,
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
  processId: number;
};

/** Application policy for claiming and resuming one persisted session. */
export class ResumeAgentSession {
  public constructor(private readonly deps: ResumeAgentSessionDependencies) {}

  public async execute(input: ResumeAgentSessionInput): Promise<ResumeAgentSessionResult> {
    let session = await this.deps.locator.execute({
      reference: input.reference,
      workspaceScope: input.workspaceScope,
    });
    if (session.status === "setup_failed")
      throw new Error(`session '${session.name}' has a failed setup; clean it up before retrying`);
    if (session.status === "starting" || session.status === "setup" || session.status === "ready")
      throw new Error(`session '${session.name}' has not started its backend; rerun it instead of resuming`);
    if (
      session.executionPid !== undefined &&
      (await this.deps.process.isAlive(session.executionPid, session.executionStartedAt))
    )
      throw new Error(`session '${session.name}' is already running (pid ${session.executionPid})`);

    const executionId = this.deps.clock.id();
    const executionStartedAt = this.deps.clock.now();
    if (
      !(await this.deps.sessions.claimExecution({
        id: session.id,
        expectedExecutionPid: session.executionPid ?? null,
        executionId,
        executionPid: this.deps.processId,
        executionStartedAt,
        updatedAt: executionStartedAt,
      }))
    ) {
      throw new Error(`session '${session.name}' is already being resumed`);
    }

    session = await this.persist(session, {
      status: "resuming",
      resuming: true,
      executionId,
      executionPid: this.deps.processId,
      executionStartedAt,
    });
    const preparation = await this.deps.launcher.prepareLaunch(session, input.backendArgs, true);
    session = await this.persistIdentityUpdate(session, preparation.sessionUpdate);

    let execution: LaunchExecution;
    try {
      await this.deps.panes.adopt(session, input.hostPaneId);
      await this.deps.panes.publish(session, "running", input.hostPaneId);
      execution = await preparation.plan.run();
      await this.deps.panes.publish(
        session,
        execution.process.interrupted ? "stopped" : execution.process.code === 0 ? "completed" : "failed",
        input.hostPaneId,
      );
    } catch (error) {
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
      throw error;
    } finally {
      try {
        await this.deps.panes.release(session, input.hostPaneId);
      } finally {
        await preparation.plan.dispose();
      }
    }

    session = await this.persistIdentityUpdate(session, execution.sessionUpdate);
    const next = await this.persist(session, {
      lastExitStatus: execution.process.code,
      executionId: clearPatch,
      executionPid: clearPatch,
      executionStartedAt: clearPatch,
      status:
        execution.process.interrupted || execution.process.code === 130 || execution.process.code === 143
          ? "interrupted"
          : "exited",
    });
    return { process: execution.process, session: next };
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
    input: SessionIdentityUpdate | undefined,
  ): Promise<AgentSessionRecord> {
    return input?.backendSessionId === undefined
      ? session
      : this.persist(session, { backendSessionId: input.backendSessionId });
  }
}
