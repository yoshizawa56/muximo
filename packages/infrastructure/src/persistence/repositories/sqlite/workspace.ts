import type { WorkspaceRepository } from "@muximo/application";
import { Workspace, WorkspaceId, type WorkspaceRecord } from "@muximo/domain";
import { asc, eq } from "drizzle-orm";
import type { AgentDrizzleDatabase } from "../../database-types.js";
import { type WorkspaceRow, workspaces } from "../../schema.js";
import { DrizzleRepositoryBase } from "./base.js";

export class DrizzleWorkspaceRepository extends DrizzleRepositoryBase implements WorkspaceRepository {
  public constructor(database: AgentDrizzleDatabase) {
    super(database);
  }

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
      .values(toWorkspaceRow(record, new Date().toISOString()))
      .onConflictDoNothing({ target: workspaces.id })
      .returning({ id: workspaces.id })
      .all();
    return inserted.length > 0;
  }

  public async upsert(record: WorkspaceRecord): Promise<void> {
    const now = new Date().toISOString();
    const row = toWorkspaceRow(record, now);
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
          updatedAt: now,
        },
      })
      .run();
  }

  public async delete(id: WorkspaceId): Promise<void> {
    this.db().delete(workspaces).where(eq(workspaces.id, id)).run();
  }
}

function toWorkspaceRow(record: WorkspaceRecord, now: string): typeof workspaces.$inferInsert {
  const workspace = Workspace.restore(record);
  return {
    id: workspace.id,
    rootPath: workspace.rootPath,
    name: workspace.name,
    isGit: workspace.isGit,
    setupScriptPath: workspace.setupScriptPath ?? null,
    cleanupScriptPath: workspace.cleanupScriptPath ?? null,
    worktreeCopyPatterns: JSON.stringify(workspace.worktreeCopyPatterns),
    createdAt: workspace.createdAt || now,
    updatedAt: now,
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
    worktreeCopyPatterns: parseWorktreeCopyPatterns(row.worktreeCopyPatterns),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function parseWorktreeCopyPatterns(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
  } catch {
    return [];
  }
}
