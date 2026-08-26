import type { WorkspaceRepository } from "@muximo/application";
import { Workspace, WorkspaceId, type WorkspaceRecord } from "@muximo/domain";
import { asc, eq } from "drizzle-orm";
import { type WorkspaceRow, workspaces } from "../../schema.js";
import { DrizzleRepositoryBase } from "./base.js";

export class DrizzleWorkspaceRepository extends DrizzleRepositoryBase implements WorkspaceRepository {
  public async findById(id: WorkspaceId): Promise<WorkspaceRecord | undefined> {
    const row = this.db().select().from(workspaces).where(eq(workspaces.id, id)).get();
    return row ? toWorkspaceRecord(row) : undefined;
  }

  public async list(): Promise<WorkspaceRecord[]> {
    return this.db().select().from(workspaces).orderBy(asc(workspaces.name)).all().map(toWorkspaceRecord);
  }

  public async insert(record: WorkspaceRecord): Promise<boolean> {
    const inserted = this.db()
      .insert(workspaces)
      .values(toWorkspaceRow(record))
      .onConflictDoNothing({ target: workspaces.id })
      .returning({ id: workspaces.id })
      .all();
    return inserted.length > 0;
  }

  public async upsert(record: WorkspaceRecord): Promise<void> {
    const row = toWorkspaceRow(record);
    this.db()
      .insert(workspaces)
      .values(row)
      .onConflictDoUpdate({
        target: workspaces.id,
        set: {
          rootPath: row.rootPath,
          name: row.name,
          isGit: row.isGit,
          setupScriptPath: row.setupScriptPath,
          cleanupScriptPath: row.cleanupScriptPath,
          worktreeCopyPatterns: row.worktreeCopyPatterns,
          updatedAt: row.updatedAt,
        },
      })
      .run();
  }

  public async delete(id: WorkspaceId): Promise<void> {
    this.db().delete(workspaces).where(eq(workspaces.id, id)).run();
  }
}

function toWorkspaceRow(record: WorkspaceRecord): typeof workspaces.$inferInsert {
  const workspace = Workspace.restore(record);
  return {
    id: workspace.id,
    rootPath: workspace.rootPath,
    name: workspace.name,
    isGit: workspace.isGit,
    setupScriptPath: workspace.setupScriptPath ?? null,
    cleanupScriptPath: workspace.cleanupScriptPath ?? null,
    worktreeCopyPatterns: JSON.stringify(workspace.worktreeCopyPatterns),
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
}

function toWorkspaceRecord(row: WorkspaceRow): WorkspaceRecord {
  return Workspace.restore({
    id: WorkspaceId.create(row.id),
    rootPath: row.rootPath,
    name: row.name,
    isGit: row.isGit,
    ...(row.setupScriptPath !== null ? { setupScriptPath: row.setupScriptPath } : {}),
    ...(row.cleanupScriptPath !== null ? { cleanupScriptPath: row.cleanupScriptPath } : {}),
    worktreeCopyPatterns: parseWorktreeCopyPatterns(row.id, row.worktreeCopyPatterns),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function parseWorktreeCopyPatterns(workspaceId: string, value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`workspace '${workspaceId}' has invalid worktree copy patterns JSON`, { cause: error });
  }
  if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) {
    throw new Error(`workspace '${workspaceId}' has invalid worktree copy patterns; expected an array of strings`);
  }
  return parsed;
}
