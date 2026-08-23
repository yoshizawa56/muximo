import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import type { AgentSessionRecord } from "@muximo/domain";
import { isProcessAlive, MuximoCommandError } from "../command-support.js";

export type LoggerLike = {
  debug(event: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): LoggerLike;
};

export type SessionLifecycleDeps = {
  logger: LoggerLike;
  env: NodeJS.ProcessEnv;
  info(message: string): void;
  locateSession(reference: string, global: boolean): Promise<AgentSessionRecord>;
  worktreeIsRegistered(session: AgentSessionRecord): boolean;
  worktreeHasAgentChanges(session: AgentSessionRecord): boolean;
  confirmCleanup(session: AgentSessionRecord, dirty: boolean): Promise<boolean>;
  removeSessionRecord(session: AgentSessionRecord, force: boolean): Promise<boolean>;
};
export async function runCleanupSession(
  options: { global: boolean; force: boolean; reference: string },
  deps: SessionLifecycleDeps,
): Promise<number> {
  const logger = deps.logger.child({ command: "cleanup" });
  const startedAt = Date.now();
  logger.debug("session.cleanup_requested", { global: options.global, force: options.force });
  const session = await deps.locateSession(options.reference, options.global);
  const sessionLogger = logger.child({
    sessionId: session.id,
    sessionName: session.name,
    workspaceId: session.workspaceId,
    backend: session.backend,
  });
  if (session.executionPid !== undefined && isProcessAlive(session.executionPid)) {
    throw new MuximoCommandError(`session '${session.name}' is still running (pid ${session.executionPid})`);
  }
  if (session.useWorktree && session.worktreePath && existsSync(session.worktreePath)) {
    if (!deps.worktreeIsRegistered(session))
      throw new MuximoCommandError(
        `managed path is not registered as a git worktree; refusing to delete it: ${session.worktreePath}`,
      );
  }
  const dirty = session.useWorktree && session.worktreePath ? deps.worktreeHasAgentChanges(session) : false;
  let force = options.force;
  sessionLogger.debug("session.cleanup_decision_started", { dirty, force });
  if (session.useWorktree && !force && !(await deps.confirmCleanup(session, dirty))) {
    sessionLogger.debug("session.cleanup_declined", { dirty });
    deps.info(`cleanup cancelled; session '${session.name}' was kept`);
    return 0;
  }
  if (dirty) force = true;
  if (!(await deps.removeSessionRecord(session, force))) {
    sessionLogger.debug("session.cleanup_failed", { dirty, force, durationMs: Date.now() - startedAt });
    deps.info(`session '${session.name}' retained because cleanup did not complete`);
    return 1;
  }
  sessionLogger.debug("session.cleanup_finished", { dirty, force, durationMs: Date.now() - startedAt });
  deps.info(`session '${session.name}' cleaned up`);
  return 0;
}

export async function confirmCleanup(
  deps: Pick<SessionLifecycleDeps, "env">,
  session: AgentSessionRecord,
  dirty: boolean,
): Promise<boolean> {
  if (deps.env.MUXIMO_ASSUME_YES === "1") return true;
  if (!process.stdin.isTTY && !process.stdout.isTTY) return false;
  const prompt = dirty
    ? `Cleanup session '${session.name}' and remove worktree '${session.worktreePath}' including uncommitted changes? [y/N] `
    : `Cleanup session '${session.name}' and remove worktree '${session.worktreePath}'? [y/N] `;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(prompt);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}
