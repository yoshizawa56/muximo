import { clearPatch, type Patch, Workspace } from "@muximo/domain";
import { Effect } from "effect";
import type { RegisterWorkspaceInput, UpdateWorkspaceInput } from "./workspace-inputs.js";
import { WorkspaceDirectoryService } from "./workspace-services.js";

/** Builds validated workspace records from host-resolved directory facts. */
export const createWorkspaceRecord = Effect.fn("Workspaces.buildRecord")(function* (
  input: RegisterWorkspaceInput,
  existing?: Workspace,
) {
  const directories = yield* WorkspaceDirectoryService;
  const directory = yield* directories.resolveDirectory(input.directory);
  const setupScriptPath =
    typeof input.setupHook === "string"
      ? yield* directories.resolveHook(input.setupHook, directory.rootPath)
      : undefined;
  const cleanupScriptPath =
    typeof input.cleanupHook === "string"
      ? yield* directories.resolveHook(input.cleanupHook, directory.rootPath)
      : undefined;
  return Workspace.create({
    id: directory.id,
    rootPath: directory.rootPath,
    name: input.name ?? existing?.name ?? directory.name,
    isGit: directory.isGit,
    ...(setupScriptPath !== undefined ? { setupScriptPath } : {}),
    ...(cleanupScriptPath !== undefined ? { cleanupScriptPath } : {}),
  });
});

export const updateWorkspaceRecord = Effect.fn("Workspaces.updateRecord")(function* (
  existing: Workspace,
  input: UpdateWorkspaceInput,
) {
  const setupHook = yield* resolveHookPatch(input.setupHook, existing.rootPath);
  const cleanupHook = yield* resolveHookPatch(input.cleanupHook, existing.rootPath);
  return existing.update({
    name: input.name,
    setupScriptPath: setupHook,
    cleanupScriptPath: cleanupHook,
  });
});

const resolveHookPatch = Effect.fn("Workspaces.resolveHookPatch")(function* (input: Patch<string>, rootPath: string) {
  if (input === undefined) return undefined;
  if (input === clearPatch) return clearPatch;
  if (typeof input === "string") {
    const directories = yield* WorkspaceDirectoryService;
    return yield* directories.resolveHook(input, rootPath);
  }
  return undefined;
});
