import { homedir } from "node:os";
import type { WorkspaceDirectory } from "@muximo/contract/api";

export function presentWorkspaceList(
  workspaces: readonly WorkspaceDirectory[],
  json: boolean,
  output: { write(value: string): void; info(message: string): void },
): number {
  if (json) {
    for (const workspace of workspaces) output.write(`${JSON.stringify(toWorkspaceJson(workspace))}\n`);
    return 0;
  }
  output.write(padRow(["ID", "NAME", "DIRECTORY", "GIT", "SETUP_HOOK", "CLEANUP_HOOK"]));
  if (workspaces.length === 0) {
    output.info("no registered workspaces");
    return 0;
  }
  for (const workspace of workspaces) {
    output.write(
      padRow([
        workspace.id,
        workspace.name,
        displayWorkspacePath(workspace.directory),
        workspace.isGit ? "yes" : "no",
        workspace.setupScriptPath ? displayWorkspacePath(workspace.setupScriptPath) : "-",
        workspace.cleanupScriptPath ? displayWorkspacePath(workspace.cleanupScriptPath) : "-",
      ]),
    );
  }
  return 0;
}

export function toWorkspaceJson(workspace: WorkspaceDirectory): Record<string, unknown> {
  return {
    id: workspace.id,
    name: workspace.name,
    directory: workspace.directory,
    is_git: workspace.isGit,
    setup_hook: workspace.setupScriptPath,
    cleanup_hook: workspace.cleanupScriptPath,
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
