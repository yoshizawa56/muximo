import type { WorkspaceRecord } from "@muximo/domain";
import type { SessionListProjection } from "./session-list.js";

/** Pure text/JSON rendering helpers shared by command modules. */
export function sessionHealthLabel(health: SessionListProjection["executionHealth"]): string {
  return health === "inactive" ? "-" : health.replaceAll("_", "-");
}

export function sessionResumeLabel(resume: SessionListProjection["resume"]): string {
  if (resume === "available") return "yes";
  if (resume === "unavailable") return "no";
  return "?";
}

export function toSessionJson(view: SessionListProjection): Record<string, unknown> {
  const { session } = view;
  return {
    id: session.id,
    name: session.name,
    backend: session.backend,
    status: session.status,
    health: view.executionHealth,
    resume: view.resume,
    resume_reason: view.resumeReason,
    workspace: session.workspaceRoot,
    workspace_id: session.workspaceId,
    workspace_name: session.workspaceName,
    worktree: session.worktreePath,
    worktree_state: view.worktreeState,
    branch: session.branch,
    session_id: session.backendSessionId,
    updated_at: session.updatedAt,
  };
}

export function toWorkspaceJson(workspace: WorkspaceRecord): Record<string, unknown> {
  return {
    id: workspace.id,
    name: workspace.name,
    directory: workspace.rootPath,
    is_git: workspace.isGit,
    setup_hook: workspace.setupScriptPath,
    cleanup_hook: workspace.cleanupScriptPath,
    worktree_copy_patterns: workspace.worktreeCopyPatterns,
    created_at: workspace.createdAt,
    updated_at: workspace.updatedAt,
  };
}

export function padHeader(values: string[]): string {
  return `${values
    .map((value) => value.padEnd(24))
    .join(" ")
    .trimEnd()}\n`;
}

export function padRow(values: string[]): string {
  return `${values
    .map((value) => value.padEnd(24))
    .join(" ")
    .trimEnd()}\n`;
}
