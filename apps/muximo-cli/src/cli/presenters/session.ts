import type { CleanupAgentSessionResult, ResumeAgentSessionResult, RunAgentSessionResult } from "@muximo/application";
import type { CliIo } from "../commands/types.js";

export function presentRunAgentSession(result: RunAgentSessionResult, io: CliIo): number {
  if (result.cleanup.disposition === "not_requested") {
    io.out.write(
      result.cleanup.reason === "interrupted"
        ? `muximo: session '${result.session.name}' kept for resume after interruption\n`
        : `muximo: session '${result.session.name}' mapping retained; use 'muximo session resume ${result.session.name}' or 'muximo session cleanup ${result.session.name}'\n`,
    );
  } else if (result.cleanup.disposition === "retained") {
    io.out.write(`muximo: ${cleanupRetainedMessage(result)}\n`);
  } else if (result.cleanup.disposition === "failed") {
    io.out.write(`muximo: ${cleanupFailedMessage(result)}\n`);
  } else {
    io.out.write(`muximo: session '${result.session.name}' cleaned up\n`);
  }
  return result.process.code === 0 && cleanupNeedsFailureStatus(result) ? 1 : result.process.code;
}

export function presentResumeAgentSession(result: ResumeAgentSessionResult, io: CliIo): number {
  if (result.session.status === "interrupted") {
    io.out.write(`muximo: session '${result.session.name}' kept for resume after interruption\n`);
  }
  return result.process.code;
}

export function presentCleanupAgentSession(result: CleanupAgentSessionResult, io: CliIo): number {
  if (result.cleanup.disposition === "removed") {
    io.out.write(`muximo: session '${result.session.name}' cleaned up\n`);
    return 0;
  }
  if (result.cleanup.reason === "cleanup_declined") {
    io.out.write(`muximo: cleanup cancelled; session '${result.session.name}' was kept\n`);
    return 0;
  }
  io.out.write(`muximo: ${cleanupFailureMessage(result)}\n`);
  return 1;
}

function cleanupRetainedMessage(result: RunAgentSessionResult): string {
  if (result.cleanup.disposition !== "retained") {
    return `session '${result.session.name}' retained because cleanup did not complete`;
  }
  if (result.cleanup.reason === "cleanup_declined") {
    return `cleanup declined; session '${result.session.name}' kept for resume`;
  }
  return `session '${result.session.name}' retained because cleanup did not complete`;
}

function cleanupFailedMessage(result: RunAgentSessionResult): string {
  return `${cleanupFailureMessage(result)} (cleanup failed; resources were retained)`;
}

function cleanupFailureMessage(result: RunAgentSessionResult | CleanupAgentSessionResult): string {
  if (result.cleanup.disposition !== "retained" && result.cleanup.disposition !== "failed") {
    return `session '${result.session.name}' retained because cleanup did not complete`;
  }
  const name = result.session.name;
  if (result.cleanup.reason === "remote_archive_failed") {
    return `session '${name}' retained because cleanup did not complete: remote archive failed`;
  }
  if (result.cleanup.reason === "cleanup_hook_failed") {
    return `session '${name}' retained because cleanup did not complete: cleanup hook failed`;
  }
  if (result.cleanup.reason === "remote_restore_failed") {
    return `session '${name}' retained because cleanup did not complete: remote restore failed`;
  }
  if (result.cleanup.reason === "unregistered_worktree") {
    return `session '${name}' retained because cleanup did not complete: worktree is not registered`;
  }
  return `session '${name}' retained because cleanup did not complete: worktree removal failed`;
}

function cleanupNeedsFailureStatus(result: RunAgentSessionResult): boolean {
  return result.cleanup.disposition === "retained" || result.cleanup.disposition === "failed";
}
