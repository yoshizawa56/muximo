import type { AgentSession } from "@muximo/domain";
import { Effect } from "effect";
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

  public readonly execute = Effect.fn("AgentSessions.cleanup")(
    { self: this },
    function* (this: CleanupAgentSession, input: CleanupAgentSessionInput) {
      const deps = this.deps;
      const session = yield* deps.locator.execute({
        reference: input.reference,
        workspaceScope: input.workspaceScope,
      });
      if (session.status === "recovering") {
        return yield* Effect.fail(new Error(`session '${session.name}' is being recovered`));
      }
      const providerLiveness =
        session.executionPid === undefined
          ? undefined
          : yield* deps.process.observe(session.executionPid, session.executionStartedAt);
      if (providerLiveness === "alive") {
        return yield* Effect.fail(
          new Error(`session '${session.name}' is still running (pid ${session.executionPid})`),
        );
      }
      if (providerLiveness === "unknown") {
        return yield* Effect.fail(new Error(`could not verify whether session '${session.name}' is still running`));
      }
      const ownerLiveness =
        session.executionOwnerPid === undefined
          ? undefined
          : yield* deps.process.observe(session.executionOwnerPid, session.executionOwnerStartedAt);
      if (
        session.executionOwnerPid !== undefined &&
        isLiveExecutionState(session.status) &&
        ownerLiveness === "alive"
      ) {
        return yield* Effect.fail(
          new Error(`session '${session.name}' is still owned by its CLI process (pid ${session.executionOwnerPid})`),
        );
      }
      if (
        session.executionOwnerPid !== undefined &&
        isLiveExecutionState(session.status) &&
        ownerLiveness === "unknown"
      ) {
        return yield* Effect.fail(
          new Error(`could not verify whether session '${session.name}' is still owned by its CLI process`),
        );
      }
      if (
        isActiveState(session.status) &&
        session.executionPid === undefined &&
        session.executionOwnerPid === undefined
      ) {
        return yield* Effect.fail(
          new Error(`session '${session.name}' has an active execution that has not attached a process`),
        );
      }
      if (session.useWorktree && session.worktreePath && !(yield* deps.worktrees.isRegistered(session))) {
        return yield* Effect.fail(
          new Error(`managed path is not registered as a git worktree; refusing to delete it: ${session.worktreePath}`),
        );
      }

      const dirty = session.useWorktree ? yield* deps.worktrees.hasChanges(session) : false;
      let force = input.force;
      if (session.useWorktree && !force && !(yield* deps.confirmCleanup.confirm(session, dirty))) {
        const retained: CleanupAgentSessionResult = {
          session,
          cleanup: { disposition: "retained", reason: "cleanup_declined" },
        };
        return retained;
      }
      if (dirty) force = true;

      const result = yield* removeResources(deps, session, force);
      return { session, cleanup: result };
    },
  );
}

const removeResources = Effect.fn("AgentSessions.removeResources")(function* (
  deps: CleanupAgentSessionDependencies,
  session: AgentSession,
  force: boolean,
) {
  const archiveRemote = session.backendSessionId !== undefined;
  if (archiveRemote && !(yield* deps.remote.archive(session))) {
    return { disposition: "failed" as const, reason: "remote_archive_failed" as const };
  }

  const hook = yield* deps.hooks.run(session, "cleanup");
  const updated = hook.sessionUpdate ? updateAgentSession(session, hook.sessionUpdate, deps.clock) : session;
  if (hook.sessionUpdate) yield* deps.sessions.update(updated);
  if (!hook.success) {
    const restored = !archiveRemote || (yield* deps.remote.restore(updated));
    return {
      disposition: "failed" as const,
      reason: restored ? ("cleanup_hook_failed" as const) : ("remote_restore_failed" as const),
    };
  }

  const result = yield* deps.worktrees.remove(updated, force);
  if (result.disposition !== "removed") {
    const restored = !archiveRemote || (yield* deps.remote.restore(updated));
    return restored ? result : { disposition: "failed" as const, reason: "remote_restore_failed" as const };
  }

  yield* deps.sessions.delete(updated.id);
  yield* deps.audit.record("agent_session.deleted", updated.id, { name: updated.name });
  yield* deps.hooks.removeOutputs(updated);
  const remaining = yield* deps.sessions.list(updated.workspaceId);
  yield* deps.resources.releaseIfUnused(updated, remaining);
  return result;
});

function isActiveState(status: AgentSession["status"]): boolean {
  return status === "running" || status === "resuming";
}

function isLiveExecutionState(status: AgentSession["status"]): boolean {
  return status !== "interrupted" && status !== "exited";
}
