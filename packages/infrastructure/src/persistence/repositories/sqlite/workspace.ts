import type { ApplicationClock, ApplicationEffect, WorkspaceRepository } from "@muximo/application";
import { Workspace, WorkspaceId } from "@muximo/domain";
import { asc, eq } from "drizzle-orm";
import { fromPromise } from "../../../effect.js";
import type { AgentDrizzleDatabase } from "../../database-types.js";
import { type WorkspaceRow, workspaces } from "../../schema.js";
import { DrizzleRepositoryBase } from "./base.js";

export class DrizzleWorkspaceRepository extends DrizzleRepositoryBase implements WorkspaceRepository {
  public constructor(
    database: AgentDrizzleDatabase,
    private readonly clock: ApplicationClock = { now: () => new Date().toISOString() },
  ) {
    super(database);
  }

  public findById(id: WorkspaceId): ApplicationEffect<Workspace | undefined> {
    return fromPromise(() => {
      const row = this.db().select().from(workspaces).where(eq(workspaces.id, id)).get();
      return row ? toWorkspace(row) : undefined;
    });
  }

  public list(): ApplicationEffect<Workspace[]> {
    return fromPromise(() => this.db().select().from(workspaces).orderBy(asc(workspaces.name)).all().map(toWorkspace));
  }

  public insert(record: Workspace): ApplicationEffect<boolean> {
    return fromPromise(() => {
      const inserted = this.db()
        .insert(workspaces)
        .values(toWorkspaceRow(record, this.clock.now()))
        .onConflictDoNothing({ target: workspaces.id })
        .returning({ id: workspaces.id })
        .all();
      return inserted.length > 0;
    });
  }

  public upsert(record: Workspace): ApplicationEffect<void> {
    return fromPromise(() => {
      const row = toWorkspaceRow(record, this.clock.now());
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
            updatedAt: row.updatedAt,
          },
        })
        .run();
    });
  }

  public delete(id: WorkspaceId): ApplicationEffect<void> {
    return fromPromise(() => {
      this.db().delete(workspaces).where(eq(workspaces.id, id)).run();
    });
  }
}

function toWorkspaceRow(record: Workspace, now: string): typeof workspaces.$inferInsert {
  return {
    id: record.id,
    rootPath: record.rootPath,
    name: record.name,
    isGit: record.isGit,
    setupScriptPath: record.setupScriptPath ?? null,
    cleanupScriptPath: record.cleanupScriptPath ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return Workspace.restore({
    id: WorkspaceId.create(row.id),
    rootPath: row.rootPath,
    name: row.name,
    isGit: row.isGit,
    ...(row.setupScriptPath !== null ? { setupScriptPath: row.setupScriptPath } : {}),
    ...(row.cleanupScriptPath !== null ? { cleanupScriptPath: row.cleanupScriptPath } : {}),
  });
}
