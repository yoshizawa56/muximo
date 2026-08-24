import type { WorkspaceDirectoryInfo } from "../../ports/workspace.js";

export class WorkspaceUseCaseError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "WorkspaceUseCaseError";
  }
}

export class WorkspaceAlreadyRegisteredError extends WorkspaceUseCaseError {
  public constructor(workspace: WorkspaceDirectoryInfo) {
    super("workspace_already_registered", `workspace is already registered: ${workspace.rootPath}`, {
      workspaceId: workspace.id,
      directory: workspace.rootPath,
    });
    this.name = "WorkspaceAlreadyRegisteredError";
  }
}

export class WorkspaceNotFoundError extends WorkspaceUseCaseError {
  public constructor(selector: string) {
    super("workspace_not_found", `workspace not found: ${selector}`, { selector });
    this.name = "WorkspaceNotFoundError";
  }
}
