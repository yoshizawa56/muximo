import type { AgentSession } from "@muximo/domain";
import { Effect } from "effect";
import type { CleanupAgentSessionInput, CleanupAgentSessionResult } from "../../ports/agent-sessions.js";
import { ApplicationFailure } from "../../ports/application.js";
import {
  HookService,
  ManagedAgentSessionRepositoryService,
  ProcessObservationService,
  RemoteSessionService,
  SessionAuditService,
  SessionCleanupConfirmationService,
  SessionResourceService,
  WorktreeService,
} from "./agent-session-services.js";
import { LocateAgentSession } from "./locate-session.js";
import { updateAgentSession } from "./session-updates.js";

/** Application policy for cleanup with explicit removed, retained, and failed outcomes. */
export class CleanupAgentSession {
  public readonly execute = Effect.fn("AgentSessions.cleanup")(
    { self: this },
    function* (this: CleanupAgentSession, input: CleanupAgentSessionInput) {
      const locator = new LocateAgentSession();
      const process = yield* ProcessObservationService;
      const worktrees = yield* WorktreeService;
      const confirmation = yield* SessionCleanupConfirmationService;
      const session = yield* locator.execute({
        reference: input.reference,
        workspaceScope: input.workspaceScope,
      });
      if (session.status === "recovering") {
        return yield* Effect.fail(
          new ApplicationFailure("agent_session_being_recovered", `session '${session.name}' is being recovered`),
        );
      }
      const providerLiveness =
        session.executionPid === undefined
          ? undefined
          : yield* process.observe(session.executionPid, session.executionStartedAt);
      if (providerLiveness === "alive") {
        return yield* Effect.fail(
          new ApplicationFailure(
            "resume_already_running",
            `session '${session.name}' is still running (pid ${session.executionPid})`,
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
      const ownerLiveness =
        session.executionOwnerPid === undefined
          ? undefined
          : yield* process.observe(session.executionOwnerPid, session.executionOwnerStartedAt);
      if (
        session.executionOwnerPid !== undefined &&
        isLiveExecutionState(session.status) &&
        ownerLiveness === "alive"
      ) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "resume_owned_by_cli",
            `session '${session.name}' is still owned by its CLI process (pid ${session.executionOwnerPid})`,
          ),
        );
      }
      if (
        session.executionOwnerPid !== undefined &&
        isLiveExecutionState(session.status) &&
        ownerLiveness === "unknown"
      ) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "resume_owner_unverifiable",
            `could not verify whether session '${session.name}' is still owned by its CLI process`,
          ),
        );
      }
      if (
        isActiveState(session.status) &&
        session.executionPid === undefined &&
        session.executionOwnerPid === undefined
      ) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "resume_execution_unattached",
            `session '${session.name}' has an active execution that has not attached a process`,
          ),
        );
      }
      if (session.useWorktree && session.worktreePath && !(yield* worktrees.isRegistered(session))) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "worktree_not_registered",
            `managed path is not registered as a git worktree; refusing to delete it: ${session.worktreePath}`,
          ),
        );
      }

      const dirty = session.useWorktree ? yield* worktrees.hasChanges(session) : false;
      let force = input.force;
      if (session.useWorktree && !force && !(yield* confirmation.confirm(session, dirty))) {
        const retained: CleanupAgentSessionResult = {
          session,
          cleanup: { disposition: "retained", reason: "cleanup_declined" },
        };
        return retained;
      }
      if (dirty) force = true;

      const result = yield* removeResources(session, force);
      return { session, cleanup: result };
    },
  );
}

const removeResources = Effect.fn("AgentSessions.removeResources")(function* (session: AgentSession, force: boolean) {
  const sessions = yield* ManagedAgentSessionRepositoryService;
  const hooks = yield* HookService;
  const remote = yield* RemoteSessionService;
  const resources = yield* SessionResourceService;
  const audit = yield* SessionAuditService;
  const worktrees = yield* WorktreeService;
  const archiveRemote = session.backendSessionId !== undefined;
  if (archiveRemote && !(yield* remote.archive(session))) {
    return { disposition: "failed" as const, reason: "remote_archive_failed" as const };
  }

  const hook = yield* hooks.run(session, "cleanup");
  const updated = hook.sessionUpdate ? yield* updateAgentSession(session, hook.sessionUpdate) : session;
  if (hook.sessionUpdate) yield* sessions.update(updated);
  if (!hook.success) {
    const restored = !archiveRemote || (yield* remote.restore(updated));
    return {
      disposition: "failed" as const,
      reason: restored ? ("cleanup_hook_failed" as const) : ("remote_restore_failed" as const),
    };
  }

  const result = yield* worktrees.remove(updated, force);
  if (result.disposition !== "removed") {
    const restored = !archiveRemote || (yield* remote.restore(updated));
    return restored ? result : { disposition: "failed" as const, reason: "remote_restore_failed" as const };
  }

  yield* sessions.delete(updated.id);
  yield* audit.record("agent_session.deleted", updated.id, { name: updated.name });
  yield* hooks.removeOutputs(updated);
  const remaining = yield* sessions.list(updated.workspaceId);
  yield* resources.releaseIfUnused(updated, remaining);
  return result;
});

function isActiveState(status: AgentSession["status"]): boolean {
  return status === "running" || status === "resuming";
}

function isLiveExecutionState(status: AgentSession["status"]): boolean {
  return status !== "interrupted" && status !== "exited";
}
