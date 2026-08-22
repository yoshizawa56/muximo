import { and, asc, eq, isNull } from "drizzle-orm";
import { AgentSession, AgentSessionId, WorkspaceId, type AgentSessionRecord } from "@muximo/domain";
import type { AgentSessionRepository } from "@muximo/application";
import type { AgentDrizzleDatabase } from "../../database-types.js";
import { agentSessions, type AgentSessionRow } from "../../schema.js";
import { DrizzleRepositoryBase } from "./base.js";

export class DrizzleAgentSessionRepository extends DrizzleRepositoryBase implements AgentSessionRepository {
  public constructor(database: AgentDrizzleDatabase) {
    super(database);
  }

  public async findById(id: AgentSessionId): Promise<AgentSessionRecord | undefined> {
    const row = this.db().select().from(agentSessions).where(eq(agentSessions.id, id)).get();
    return row ? toAgentSessionRecord(row) : undefined;
  }

  public async findByName(workspaceId: WorkspaceId, name: string): Promise<AgentSessionRecord | undefined> {
    const row = this.db()
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.workspaceId, workspaceId), eq(agentSessions.name, name)))
      .get();
    return row ? toAgentSessionRecord(row) : undefined;
  }

  public async list(workspaceId?: WorkspaceId): Promise<AgentSessionRecord[]> {
    const rows = workspaceId
      ? this.db().select().from(agentSessions).where(eq(agentSessions.workspaceId, workspaceId)).orderBy(asc(agentSessions.name)).all()
      : this.db().select().from(agentSessions).orderBy(asc(agentSessions.workspaceName), asc(agentSessions.name)).all();
    return rows.map(toAgentSessionRecord);
  }

  public async insert(record: AgentSessionRecord): Promise<void> {
    const now = new Date().toISOString();
    this.db().insert(agentSessions).values(toAgentSessionRow(record, now)).run();
  }

  public async update(record: AgentSessionRecord): Promise<void> {
    const now = new Date().toISOString();
    const row = toAgentSessionRow(record, now);
    this.db()
      .update(agentSessions)
      .set(row)
      .where(eq(agentSessions.id, record.id))
      .run();
  }

  public async claimExecution(id: AgentSessionId, expectedExecutionPid: number | null, executionId: string, executionPid: number, executionStartedAt: string): Promise<boolean> {
    const predicate = expectedExecutionPid === null
      ? and(eq(agentSessions.id, id), isNull(agentSessions.executionPid))
      : and(eq(agentSessions.id, id), eq(agentSessions.executionPid, expectedExecutionPid));
    const result = this.db()
      .update(agentSessions)
      .set({ executionId, executionPid, executionStartedAt, status: "resuming", resuming: true, updatedAt: new Date().toISOString() })
      .where(predicate)
      .returning({ id: agentSessions.id })
      .all();
    return result.length > 0;
  }

  public async setBackendSessionIdIfMissing(id: AgentSessionId, backendSessionId: string): Promise<boolean> {
    const result = this.db()
      .update(agentSessions)
      .set({ backendSessionId, updatedAt: new Date().toISOString() })
      .where(and(eq(agentSessions.id, id), isNull(agentSessions.backendSessionId)))
      .returning({ id: agentSessions.id })
      .all();
    return result.length > 0;
  }

  public async delete(id: AgentSessionId): Promise<void> {
    this.db().delete(agentSessions).where(eq(agentSessions.id, id)).run();
  }
}

function toAgentSessionRow(record: AgentSessionRecord, now: string): typeof agentSessions.$inferInsert {
  const session = AgentSession.validate(record);
  return {
    id: session.id,
    name: session.name,
    backend: session.backend,
    status: session.status,
    workspaceId: session.workspaceId,
    workspaceRoot: session.workspaceRoot,
    workspaceName: session.workspaceName,
    worktreeRoot: session.worktreeRoot ?? null,
    worktreePath: session.worktreePath ?? null,
    branch: session.branch ?? null,
    baseCommit: session.baseCommit ?? null,
    useWorktree: session.useWorktree,
    setupHook: session.setupHook ?? null,
    cleanupHook: session.cleanupHook ?? null,
    setupOutputFile: session.setupOutputFile ?? null,
    cleanupOutputFile: session.cleanupOutputFile ?? null,
    backendSessionId: session.backendSessionId ?? null,
    codexProfile: session.codexProfile ?? null,
    codexRemote: session.codexRemote ?? null,
    setupRan: session.setupRan,
    resuming: session.resuming,
    baselineStatus: session.baselineStatus ?? null,
    codexSessionBaseline: session.codexSessionBaseline ?? null,
    lastExitStatus: session.lastExitStatus ?? null,
    executionId: session.executionId ?? null,
    executionPid: session.executionPid ?? null,
    executionStartedAt: session.executionStartedAt ?? null,
    createdAt: session.createdAt || now,
    updatedAt: now,
  };
}

function toAgentSessionRecord(row: AgentSessionRow): AgentSessionRecord {
  return AgentSession.validate({
    id: AgentSessionId.create(row.id),
    name: row.name,
    backend: row.backend,
    status: row.status,
    workspaceId: WorkspaceId.create(row.workspaceId),
    workspaceRoot: row.workspaceRoot,
    workspaceName: row.workspaceName,
    ...(row.worktreeRoot !== null ? { worktreeRoot: row.worktreeRoot } : {}),
    ...(row.worktreePath !== null ? { worktreePath: row.worktreePath } : {}),
    ...(row.branch !== null ? { branch: row.branch } : {}),
    ...(row.baseCommit !== null ? { baseCommit: row.baseCommit } : {}),
    useWorktree: row.useWorktree,
    ...(row.setupHook !== null ? { setupHook: row.setupHook } : {}),
    ...(row.cleanupHook !== null ? { cleanupHook: row.cleanupHook } : {}),
    ...(row.setupOutputFile !== null ? { setupOutputFile: row.setupOutputFile } : {}),
    ...(row.cleanupOutputFile !== null ? { cleanupOutputFile: row.cleanupOutputFile } : {}),
    ...(row.backendSessionId !== null ? { backendSessionId: row.backendSessionId } : {}),
    ...(row.codexProfile !== null ? { codexProfile: row.codexProfile } : {}),
    ...(row.codexRemote !== null ? { codexRemote: row.codexRemote } : {}),
    setupRan: row.setupRan,
    resuming: row.resuming,
    ...(row.baselineStatus !== null ? { baselineStatus: row.baselineStatus } : {}),
    ...(row.codexSessionBaseline !== null ? { codexSessionBaseline: row.codexSessionBaseline } : {}),
    ...(row.lastExitStatus !== null ? { lastExitStatus: row.lastExitStatus } : {}),
    ...(row.executionId ? { executionId: row.executionId } : {}),
    ...(row.executionPid !== null ? { executionPid: row.executionPid } : {}),
    ...(row.executionStartedAt ? { executionStartedAt: row.executionStartedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}
