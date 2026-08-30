import type { AgentSessionRecord } from "@muximo/domain";
import type {
  CleanupAgentSessionInput,
  CleanupAgentSessionResult,
  HookPort,
  ManagedAgentSessionRepository,
  ProcessObservationPort,
  RemoteSessionPort,
  SessionAuditPort,
  SessionCleanupConfirmationPort,
  SessionClock,
  SessionResourcePort,
  WorktreePort,
} from "../../ports/agent-sessions.js";
import type { LocateAgentSession } from "./locate-session.js";
import { updateAgentSession } from "./session-updates.js";

export type CleanupAgentSessionDependencies = {
  sessions: ManagedAgentSessionRepository;
  locator: LocateAgentSession;
  process: ProcessObservationPort;
  worktrees: WorktreePort;
  hooks: HookPort;
  remote: RemoteSessionPort;
  resources: SessionResourcePort;
  audit: SessionAuditPort;
  confirmCleanup: SessionCleanupConfirmationPort;
  clock: SessionClock;
};

/** Application policy for cleanup with explicit removed, retained, and failed outcomes. */
export class CleanupAgentSession {
  public constructor(private readonly deps: CleanupAgentSessionDependencies) {}

  public async execute(input: CleanupAgentSessionInput): Promise<CleanupAgentSessionResult> {
    const session = await this.deps.locator.execute({
      reference: input.reference,
      workspaceScope: input.workspaceScope,
    });
    if ((session.status === "running" || session.status === "resuming") && session.executionPid === undefined) {
      throw new Error(`session '${session.name}' has an active execution that has not attached a process`);
    }
    if (
      session.executionPid !== undefined &&
      (await this.deps.process.isAlive(session.executionPid, session.executionStartedAt))
    )
      throw new Error(`session '${session.name}' is still running (pid ${session.executionPid})`);
    if (session.useWorktree && session.worktreePath && !(await this.deps.worktrees.isRegistered(session))) {
      throw new Error(
        `managed path is not registered as a git worktree; refusing to delete it: ${session.worktreePath}`,
      );
    }

    const dirty = session.useWorktree ? await this.deps.worktrees.hasChanges(session) : false;
    let force = input.force;
    if (session.useWorktree && !force && !(await this.deps.confirmCleanup.confirm(session, dirty))) {
      return { session, cleanup: { disposition: "retained", reason: "cleanup_declined" } };
    }
    if (dirty) force = true;

    const result = await this.removeResources(session, force);
    return { session, cleanup: result };
  }

  private async removeResources(session: AgentSessionRecord, force: boolean) {
    const archiveRemote = session.backendSessionId !== undefined;
    if (archiveRemote && !(await this.deps.remote.archive(session))) {
      return { disposition: "failed" as const, reason: "remote_archive_failed" as const };
    }

    const hook = await this.deps.hooks.run(session, "cleanup");
    const updated = hook.sessionUpdate ? updateAgentSession(session, hook.sessionUpdate, this.deps.clock) : session;
    if (hook.sessionUpdate) await this.deps.sessions.update(updated);
    if (!hook.success) {
      const restored = !archiveRemote || (await this.deps.remote.restore(updated));
      return {
        disposition: "failed" as const,
        reason: restored ? ("cleanup_hook_failed" as const) : ("remote_restore_failed" as const),
      };
    }

    const result = await this.deps.worktrees.remove(updated, force);
    if (result.disposition !== "removed") {
      const restored = !archiveRemote || (await this.deps.remote.restore(updated));
      return restored ? result : { disposition: "failed" as const, reason: "remote_restore_failed" as const };
    }

    await this.deps.sessions.delete(updated.id);
    await this.deps.audit.record("agent_session.deleted", updated.id, { name: updated.name });
    await this.deps.hooks.removeOutputs(updated);
    const remaining = await this.deps.sessions.list(updated.workspaceId);
    await this.deps.resources.releaseIfUnused(updated, remaining);
    return result;
  }
}
