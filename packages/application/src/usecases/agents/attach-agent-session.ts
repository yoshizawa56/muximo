import { AgentSession, AgentSessionId, type AgentSessionRecord } from "@muximo/domain";
import type {
  AttachAgentSessionInput,
  ManagedAgentSessionRepository,
  PanePublicationPort,
  SessionClock,
  SessionLauncherPort,
} from "../../ports/agent-sessions.js";

export type AttachAgentSessionDependencies = {
  sessions: ManagedAgentSessionRepository;
  launcher: SessionLauncherPort;
  panes: PanePublicationPort;
  clock: SessionClock;
};

/** Records the actual provider PID and starts daemon-side observation after host launch. */
export class AttachAgentSession {
  public constructor(private readonly deps: AttachAgentSessionDependencies) {}

  public async execute(input: AttachAgentSessionInput): Promise<void> {
    const id = AgentSessionId.create(input.agentSessionId);
    const session = await this.deps.sessions.findById(id);
    // Attachment is best-effort bookkeeping. The host process may finish and
    // the daemon may finalize or delete the session before a delayed attach
    // request reaches it; that stale request must not become a second failure.
    if (!session) return;
    if (session.executionId !== input.executionId) {
      if (session.executionId === undefined && isTerminalState(session.status)) return;
      throw new Error("agent execution is no longer current");
    }
    if (session.status !== "running" && session.status !== "resuming") {
      if (isTerminalState(session.status)) return;
      throw new Error(`agent session '${session.name}' is not awaiting a provider process`);
    }
    let attached: AgentSessionRecord;
    if (session.executionPid !== undefined) {
      if (session.executionPid !== input.executionPid)
        throw new Error(`agent session '${session.name}' is already attached to another process`);
      attached = session;
    } else {
      const updatedAt = this.deps.clock.now();
      const claimed = await this.deps.sessions.attachExecution({
        id,
        executionId: input.executionId,
        expectedExecutionOwnerPid: input.executionOwnerPid ?? null,
        expectedExecutionOwnerStartedAt: input.executionOwnerStartedAt ?? null,
        executionPid: input.executionPid,
        executionStartedAt: input.executionStartedAt,
        updatedAt,
      });
      const current = claimed ? undefined : await this.deps.sessions.findById(id);
      if (!claimed) {
        if (current?.executionId !== input.executionId || current.executionPid !== input.executionPid) {
          throw new Error(`agent session '${session.name}' is already attached to another process`);
        }
        // Another attach request committed the same process identity. Continue
        // through the side effects so a lost response can repair observation.
        attached = current;
      } else {
        attached = AgentSession.update(session, {
          executionPid: input.executionPid,
          executionStartedAt: input.executionStartedAt,
          updatedAt,
        });
      }
    }

    // These operations are intentionally idempotent. In particular, a retry
    // after a daemon crash must restore pane adoption and monitoring even when
    // the database already contains the provider PID.
    await this.deps.panes.adopt(attached, input.hostPaneId);
    await this.deps.panes.publish(attached, "running", input.hostPaneId);
    await this.deps.launcher.startLaunch(attached);
  }
}

function isTerminalState(status: AgentSessionRecord["status"]): boolean {
  return status === "interrupted" || status === "exited";
}
