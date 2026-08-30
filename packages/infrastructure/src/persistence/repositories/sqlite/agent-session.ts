import type {
  AgentExecutionReceipt,
  AgentSessionRepository,
  AttachExecutionInput,
  ClaimAbandonedExecutionInput,
  ClaimExecutionInput,
  ManagedAgentSessionRepository,
} from "@muximo/application";
import { AgentSession, AgentSessionId, type AgentSessionRecord, WorkspaceId } from "@muximo/domain";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { type AgentSessionRow, agentExecutionReceipts, agentSessions } from "../../schema.js";
import { DrizzleRepositoryBase } from "./base.js";

export class DrizzleAgentSessionRepository
  extends DrizzleRepositoryBase
  implements AgentSessionRepository, ManagedAgentSessionRepository
{
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
      ? this.db()
          .select()
          .from(agentSessions)
          .where(eq(agentSessions.workspaceId, workspaceId))
          .orderBy(asc(agentSessions.name))
          .all()
      : this.db().select().from(agentSessions).orderBy(asc(agentSessions.workspaceName), asc(agentSessions.name)).all();
    return rows.map(toAgentSessionRecord);
  }

  public async insert(record: AgentSessionRecord): Promise<void> {
    this.db().insert(agentSessions).values(toAgentSessionRow(record)).run();
  }

  public async update(record: AgentSessionRecord): Promise<void> {
    const row = toAgentSessionRow(record);
    this.db().update(agentSessions).set(row).where(eq(agentSessions.id, record.id)).run();
  }

  public async claimExecution({
    id,
    expectedExecutionPid,
    executionId,
    executionPid,
    executionStartedAt,
    executionOwnerPid,
    executionOwnerStartedAt,
    updatedAt,
  }: ClaimExecutionInput): Promise<boolean> {
    const predicate =
      expectedExecutionPid === null
        ? and(eq(agentSessions.id, id), isNull(agentSessions.executionPid))
        : and(eq(agentSessions.id, id), eq(agentSessions.executionPid, expectedExecutionPid));
    const result = this.db()
      .update(agentSessions)
      .set({
        executionId,
        executionPid,
        executionStartedAt,
        executionOwnerPid,
        executionOwnerStartedAt,
        status: "resuming",
        resuming: true,
        updatedAt,
      })
      .where(predicate)
      .returning({ id: agentSessions.id })
      .all();
    return result.length > 0;
  }

  public async claimAbandonedExecution({
    id,
    executionId,
    expectedExecutionPid,
    expectedExecutionStartedAt,
    expectedExecutionOwnerPid,
    expectedExecutionOwnerStartedAt,
    updatedAt,
  }: ClaimAbandonedExecutionInput): Promise<boolean> {
    const result = this.db()
      .update(agentSessions)
      .set({ status: "recovering", resuming: false, updatedAt })
      .where(
        and(
          eq(agentSessions.id, id),
          eq(agentSessions.executionId, executionId),
          inArray(agentSessions.status, ["running", "resuming"]),
          expectedExecutionPid === null
            ? isNull(agentSessions.executionPid)
            : eq(agentSessions.executionPid, expectedExecutionPid),
          expectedExecutionStartedAt === null
            ? isNull(agentSessions.executionStartedAt)
            : eq(agentSessions.executionStartedAt, expectedExecutionStartedAt),
          expectedExecutionOwnerPid === null
            ? isNull(agentSessions.executionOwnerPid)
            : eq(agentSessions.executionOwnerPid, expectedExecutionOwnerPid),
          expectedExecutionOwnerStartedAt === null
            ? isNull(agentSessions.executionOwnerStartedAt)
            : eq(agentSessions.executionOwnerStartedAt, expectedExecutionOwnerStartedAt),
        ),
      )
      .returning({ id: agentSessions.id })
      .all();
    return result.length > 0;
  }

  public async attachExecution({
    id,
    executionId,
    expectedExecutionOwnerPid,
    expectedExecutionOwnerStartedAt,
    executionPid,
    executionStartedAt,
    updatedAt,
  }: AttachExecutionInput): Promise<boolean> {
    const result = this.db()
      .update(agentSessions)
      .set({ executionPid, executionStartedAt, updatedAt })
      .where(
        and(
          eq(agentSessions.id, id),
          eq(agentSessions.executionId, executionId),
          inArray(agentSessions.status, ["running", "resuming"]),
          isNull(agentSessions.executionPid),
          expectedExecutionOwnerPid === null
            ? isNull(agentSessions.executionOwnerPid)
            : eq(agentSessions.executionOwnerPid, expectedExecutionOwnerPid),
          expectedExecutionOwnerStartedAt === null
            ? isNull(agentSessions.executionOwnerStartedAt)
            : eq(agentSessions.executionOwnerStartedAt, expectedExecutionOwnerStartedAt),
        ),
      )
      .returning({ id: agentSessions.id })
      .all();
    return result.length > 0;
  }

  public async findExecutionReceipt(executionId: string): Promise<AgentExecutionReceipt | undefined> {
    const row = this.db()
      .select()
      .from(agentExecutionReceipts)
      .where(eq(agentExecutionReceipts.executionId, executionId))
      .get();
    return row ? toAgentExecutionReceipt(row) : undefined;
  }

  public async saveExecutionReceipt(receipt: AgentExecutionReceipt): Promise<void> {
    this.db()
      .insert(agentExecutionReceipts)
      .values({
        executionId: receipt.executionId,
        agentSessionId: receipt.agentSessionId,
        operation: receipt.operation,
        process: JSON.stringify(receipt.process),
        session: JSON.stringify(receipt.session),
        cleanup: "cleanup" in receipt ? JSON.stringify(receipt.cleanup) : null,
        createdAt: receipt.session.updatedAt,
        updatedAt: receipt.session.updatedAt,
      })
      .onConflictDoNothing()
      .run();
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

function toAgentSessionRow(record: AgentSessionRecord): typeof agentSessions.$inferInsert {
  const session = AgentSession.restore(record);
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
    setupRan: session.setupRan,
    resuming: session.resuming,
    baselineStatus: session.baselineStatus ?? null,
    lastExitStatus: session.lastExitStatus ?? null,
    executionId: session.executionId ?? null,
    executionPid: session.executionPid ?? null,
    executionStartedAt: session.executionStartedAt ?? null,
    executionOwnerPid: session.executionOwnerPid ?? null,
    executionOwnerStartedAt: session.executionOwnerStartedAt ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
}

function toAgentSessionRecord(row: AgentSessionRow): AgentSessionRecord {
  return AgentSession.restore({
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
    setupRan: row.setupRan,
    resuming: row.resuming,
    ...(row.baselineStatus !== null ? { baselineStatus: row.baselineStatus } : {}),
    ...(row.lastExitStatus !== null ? { lastExitStatus: row.lastExitStatus } : {}),
    ...(row.executionId ? { executionId: row.executionId } : {}),
    ...(row.executionPid !== null ? { executionPid: row.executionPid } : {}),
    ...(row.executionStartedAt ? { executionStartedAt: row.executionStartedAt } : {}),
    ...(row.executionOwnerPid !== null ? { executionOwnerPid: row.executionOwnerPid } : {}),
    ...(row.executionOwnerStartedAt ? { executionOwnerStartedAt: row.executionOwnerStartedAt } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function toAgentExecutionReceipt(row: typeof agentExecutionReceipts.$inferSelect): AgentExecutionReceipt {
  const process = JSON.parse(row.process) as AgentExecutionReceipt["process"];
  const session = AgentSession.restore(JSON.parse(row.session));
  if (row.operation === "run") {
    if (row.cleanup === null) throw new Error(`execution receipt is missing cleanup: ${row.executionId}`);
    return {
      operation: row.operation,
      agentSessionId: row.agentSessionId,
      executionId: row.executionId,
      process,
      session,
      cleanup: JSON.parse(row.cleanup) as Extract<AgentExecutionReceipt, { operation: "run" }>["cleanup"],
    };
  }
  return {
    operation: row.operation,
    agentSessionId: row.agentSessionId,
    executionId: row.executionId,
    process,
    session,
  };
}
