import { homedir } from "node:os";
import type { WorkspaceRecord } from "@muximo/domain";

export function presentWorkspaceList(
  workspaces: readonly WorkspaceRecord[],
  json: boolean,
  output: { write(value: string): void; info(message: string): void },
): number {
  if (json) {
    for (const workspace of workspaces) output.write(`${JSON.stringify(toWorkspaceJson(workspace))}\n`);
    return 0;
  }
  output.write(padRow(["ID", "NAME", "DIRECTORY", "GIT", "SETUP_HOOK", "CLEANUP_HOOK", "COPY_PATTERNS"]));
  if (workspaces.length === 0) {
    output.info("no registered workspaces");
    return 0;
  }
  for (const workspace of workspaces) {
    output.write(
      padRow([
        workspace.id,
        workspace.name,
        displayWorkspacePath(workspace.rootPath),
        workspace.isGit ? "yes" : "no",
        workspace.setupScriptPath ? displayWorkspacePath(workspace.setupScriptPath) : "-",
        workspace.cleanupScriptPath ? displayWorkspacePath(workspace.cleanupScriptPath) : "-",
        workspace.worktreeCopyPatterns.length > 0 ? workspace.worktreeCopyPatterns.join(",") : "-",
      ]),
    );
  }
  return 0;
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

export function displayWorkspacePath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function padRow(values: readonly string[]): string {
  return `${values
    .map((value) => value.padEnd(24))
    .join(" ")
    .trimEnd()}\n`;
}
