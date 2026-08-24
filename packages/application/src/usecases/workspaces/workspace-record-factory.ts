import { clearPatch, type Patch, Workspace, type WorkspaceRecord } from "@muximo/domain";
import type { ApplicationClock } from "../../ports/application.js";
import type { WorkspaceDirectoryPort } from "../../ports/workspace.js";
import type { RegisterWorkspaceInput, UpdateWorkspaceInput } from "./workspace-inputs.js";

/** Builds validated workspace records from host-resolved directory facts. */
export class WorkspaceRecordFactory {
  public constructor(
    private readonly directories: WorkspaceDirectoryPort,
    private readonly clock: ApplicationClock,
  ) {}

  public async create(input: RegisterWorkspaceInput, existing?: WorkspaceRecord): Promise<WorkspaceRecord> {
    const directory = await this.directories.resolveDirectory(input.directory);
    const now = this.clock.now();
    const setupScriptPath = await this.resolveCreateHook(input.setupHook, directory.rootPath);
    const cleanupScriptPath = await this.resolveCreateHook(input.cleanupHook, directory.rootPath);
    return Workspace.create({
      id: directory.id,
      rootPath: directory.rootPath,
      name: input.name ?? existing?.name ?? directory.name,
      isGit: directory.isGit,
      ...(setupScriptPath !== undefined ? { setupScriptPath } : {}),
      ...(cleanupScriptPath !== undefined ? { cleanupScriptPath } : {}),
      worktreeCopyPatterns: input.worktreeCopyPatterns ?? existing?.worktreeCopyPatterns ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  public async update(existing: WorkspaceRecord, input: UpdateWorkspaceInput): Promise<WorkspaceRecord> {
    const setupHook = await this.resolveHookPatch(input.setupHook, existing.rootPath);
    const cleanupHook = await this.resolveHookPatch(input.cleanupHook, existing.rootPath);
    return Workspace.update(existing, {
      name: input.name,
      setupScriptPath: setupHook,
      cleanupScriptPath: cleanupHook,
      worktreeCopyPatterns: input.worktreeCopyPatterns,
      appendWorktreeCopyPatterns: input.appendCopyPatterns,
      clearWorktreeCopyPatterns: input.clearCopyPatterns,
      updatedAt: this.clock.now(),
    });
  }

  private async resolveCreateHook(input: Patch<string>, rootPath: string): Promise<string | undefined> {
    if (typeof input !== "string") return undefined;
    return this.directories.resolveHook(input, rootPath);
  }

  private async resolveHookPatch(input: Patch<string>, rootPath: string): Promise<Patch<string>> {
    if (input === undefined) return undefined;
    if (input === clearPatch) return clearPatch;
    if (typeof input === "string") return this.directories.resolveHook(input, rootPath);
    return undefined;
  }
}
