import type { WorkspaceRecord } from "@muximo/domain";
import type { WorkspaceRepository } from "../../ports/repositories.js";
import type { WorkspaceDirectoryPort } from "../../ports/workspace.js";
import { WorkspaceNotFoundError, WorkspaceUseCaseError } from "./workspace-errors.js";

/**
 * Resolves a workspace by ID, registered path, or unique name. Shared by the
 * workspace mutations that accept free-form selectors.
 */
export async function findWorkspace(
  workspaces: WorkspaceRepository,
  directories: WorkspaceDirectoryPort,
  selector: string,
): Promise<WorkspaceRecord> {
  const reference = selector.trim();
  if (!reference) throw new WorkspaceNotFoundError(selector);
  const records = await workspaces.list();
  const byId = records.find((workspace) => workspace.id === reference);
  if (byId) return byId;

  let resolved: Awaited<ReturnType<WorkspaceDirectoryPort["resolveDirectory"]>> | undefined;
  try {
    resolved = await directories.resolveDirectory(reference);
  } catch {
    // A selector is commonly a workspace name. Directory resolution is only
    // a fallback for path selectors, so expected path failures are ignored.
  }
  if (resolved) {
    const byPath = records.find(
      (workspace) => workspace.id === resolved?.id || workspace.rootPath === resolved?.rootPath,
    );
    if (byPath) return byPath;
  }

  const byName = records.filter((workspace) => workspace.name === reference);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new WorkspaceUseCaseError(
      "workspace_name_ambiguous",
      `workspace name is ambiguous; use its ID: ${reference}`,
      { selector: reference },
    );
  }
  throw new WorkspaceNotFoundError(reference);
}
