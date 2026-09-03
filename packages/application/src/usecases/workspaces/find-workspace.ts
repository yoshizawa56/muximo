import { Effect, Result } from "effect";
import type { WorkspaceDirectoryInfo } from "../../ports/workspace.js";
import { WorkspaceNotFoundError, WorkspaceUseCaseError } from "./workspace-errors.js";
import { WorkspaceDirectoryService, WorkspaceRepositoryService } from "./workspace-services.js";

/**
 * Resolves a workspace by registered path or unique name. Shared by the
 * workspace mutations that accept free-form selectors.
 */
export const findWorkspace = Effect.fn("Workspaces.find")(function* (selector: string) {
  const workspaces = yield* WorkspaceRepositoryService;
  const directories = yield* WorkspaceDirectoryService;
  const reference = selector.trim();
  if (!reference) return yield* Effect.fail(new WorkspaceNotFoundError(selector));
  const records = yield* workspaces.list();

  let resolved: WorkspaceDirectoryInfo | undefined;
  const directoryResult = yield* Effect.result(directories.resolveDirectory(reference));
  if (Result.isFailure(directoryResult)) {
    // A selector is commonly a workspace name. Directory resolution is only
    // a fallback for path selectors, so only an adapter-declared invalid
    // directory selector may fall through to name matching.
    if (!isInvalidDirectorySelectorError(directoryResult.failure)) return yield* Effect.fail(directoryResult.failure);
  } else {
    resolved = directoryResult.success;
  }
  if (resolved) {
    const byPath = records.find(
      (workspace) => workspace.id === resolved?.id || workspace.rootPath === resolved?.rootPath,
    );
    if (byPath) return byPath;
  }

  const byName = records.filter((workspace) => workspace.name === reference);
  const [workspace] = byName;
  if (byName.length === 1 && workspace) return workspace;
  if (byName.length > 1) {
    return yield* Effect.fail(
      new WorkspaceUseCaseError(
        "workspace_name_ambiguous",
        `workspace name is ambiguous; select its path: ${reference}`,
        { selector: reference },
      ),
    );
  }
  return yield* Effect.fail(new WorkspaceNotFoundError(reference));
});

function isInvalidDirectorySelectorError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "invalid_directory"
  );
}
