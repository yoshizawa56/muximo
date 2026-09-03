import type {
  AgentExecutionReceipt,
  AgentSessionRepository,
  ApplicationClock,
  ApplicationEffect,
  AttachExecutionInput,
  ClaimAbandonedExecutionInput,
  ClaimExecutionInput,
  ManagedAgentSessionRepository,
} from "@muximo/application";
import { AgentSession, AgentSessionId, WorkspaceId } from "@muximo/domain";
import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { fromPromise } from "../../../effect.js";
import type { AgentDrizzleDatabase } from "../../database-types.js";
import { type AgentSessionRow, agentExecutionReceipts, agentSessions } from "../../schema.js";
import { DrizzleRepositoryBase } from "./base.js";

// Completion receipts are only needed to replay a lost control response. Keep
// them long enough for a delayed retry without retaining finalized session
// snapshots indefinitely.
const executionReceiptRetentionMs = 7 * 24 * 60 * 60 * 1_000;

export class DrizzleAgentSessionRepository
  extends DrizzleRepositoryBase
  implements AgentSessionRepository, ManagedAgentSessionRepository
{
  public constructor(
    database: AgentDrizzleDatabase,
    private readonly clock: ApplicationClock = { now: () => new Date().toISOString() },
  ) {
    super(database);
  }
  public findById(id: AgentSessionId): ApplicationEffect<AgentSession | undefined> {
    return fromPromise(() => {
      const row = this.db().select().from(agentSessions).where(eq(agentSessions.id, id)).get();
      return row ? toAgentSession(row) : undefined;
    });
  }

  public findByName(workspaceId: WorkspaceId, name: string): ApplicationEffect<AgentSession | undefined> {
    return fromPromise(() => {
      const row = this.db()
        .select()
        .from(agentSessions)
        .where(and(eq(agentSessions.workspaceId, workspaceId), eq(agentSessions.name, name)))
        .get();
      return row ? toAgentSession(row) : undefined;
    });
  }

  public list(workspaceId?: WorkspaceId): ApplicationEffect<AgentSession[]> {
    return fromPromise(() => {
      const rows = workspaceId
        ? this.db()
            .select()
            .from(agentSessions)
            .where(eq(agentSessions.workspaceId, workspaceId))
            .orderBy(asc(agentSessions.name))
            .all()
        : this.db()
            .select()
            .from(agentSessions)
            .orderBy(asc(agentSessions.workspaceName), asc(agentSessions.name))
            .all();
      return rows.map(toAgentSession);
    });
  }

  public insert(record: AgentSession): ApplicationEffect<void> {
    return fromPromise(() => {
      const now = this.clock.now();
      this.db()
        .insert(agentSessions)
        .values({ ...toAgentSessionRow(record), createdAt: now })
        .run();
    });
  }

  public update(record: AgentSession): ApplicationEffect<void> {
    return fromPromise(() => {
      const row = toAgentSessionRow(record);
      this.db().update(agentSessions).set(row).where(eq(agentSessions.id, record.id)).run();
    });
  }

  public claimExecution({
    id,
    expectedExecutionPid,
    executionId,
    executionPid,
    executionStartedAt,
    executionOwnerPid,
    executionOwnerStartedAt,
    lastActivityAt,
  }: ClaimExecutionInput): ApplicationEffect<boolean> {
    return fromPromise(() => {
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
          updatedAt: lastActivityAt,
        })
        .where(predicate)
        .returning({ id: agentSessions.id })
        .all();
      return result.length > 0;
    });
  }

  public claimAbandonedExecution({
    id,
    executionId,
    expectedExecutionPid,
    expectedExecutionStartedAt,
    expectedExecutionOwnerPid,
    expectedExecutionOwnerStartedAt,
    lastActivityAt,
  }: ClaimAbandonedExecutionInput): ApplicationEffect<boolean> {
    return fromPromise(() => {
      const result = this.db()
        .update(agentSessions)
        .set({ status: "recovering", resuming: false, updatedAt: lastActivityAt })
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
    });
  }

  public attachExecution({
    id,
    executionId,
    expectedExecutionOwnerPid,
    expectedExecutionOwnerStartedAt,
    executionPid,
    executionStartedAt,
    lastActivityAt,
  }: AttachExecutionInput): ApplicationEffect<boolean> {
    return fromPromise(() => {
      const result = this.db()
        .update(agentSessions)
        .set({ executionPid, executionStartedAt, updatedAt: lastActivityAt })
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
    });
  }

  public findExecutionReceipt(executionId: string): ApplicationEffect<AgentExecutionReceipt | undefined> {
    return fromPromise(() => {
      const row = this.db()
        .select()
        .from(agentExecutionReceipts)
        .where(eq(agentExecutionReceipts.executionId, executionId))
        .get();
      return row ? toAgentExecutionReceipt(row) : undefined;
    });
  }

  public saveExecutionReceipt(receipt: AgentExecutionReceipt): ApplicationEffect<void> {
    return fromPromise(() => {
      const now = this.clock.now();
      this.db()
        .insert(agentExecutionReceipts)
        .values({
          executionId: receipt.executionId,
          agentSessionId: receipt.agentSessionId,
          operation: receipt.operation,
          process: JSON.stringify(receipt.process),
          session: JSON.stringify(receipt.session),
          cleanup: "cleanup" in receipt ? JSON.stringify(receipt.cleanup) : null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();

      const nowMs = Date.parse(now);
      if (!Number.isFinite(nowMs)) return;
      const cutoff = new Date(nowMs - executionReceiptRetentionMs).toISOString();
      this.db().delete(agentExecutionReceipts).where(lt(agentExecutionReceipts.updatedAt, cutoff)).run();
    });
  }

  public setBackendSessionIdIfMissing(id: AgentSessionId, backendSessionId: string): ApplicationEffect<boolean> {
    return fromPromise(() => {
      const result = this.db()
        .update(agentSessions)
        .set({ backendSessionId, updatedAt: this.clock.now() })
        .where(and(eq(agentSessions.id, id), isNull(agentSessions.backendSessionId)))
        .returning({ id: agentSessions.id })
        .all();
      return result.length > 0;
    });
  }

  public delete(id: AgentSessionId): ApplicationEffect<void> {
    return fromPromise(() => {
      this.db().delete(agentSessions).where(eq(agentSessions.id, id)).run();
    });
  }
}

function toAgentSessionRow(record: AgentSession): Omit<typeof agentSessions.$inferInsert, "createdAt"> {
  return {
    id: record.id,
    name: record.name,
    backend: record.backend,
    status: record.status,
    workspaceId: record.workspaceId,
    workspaceRoot: record.workspaceRoot,
    workspaceName: record.workspaceName,
    worktreeRoot: record.worktreeRoot ?? null,
    worktreePath: record.worktreePath ?? null,
    branch: record.branch ?? null,
    baseCommit: record.baseCommit ?? null,
    useWorktree: record.useWorktree,
    setupHook: record.setupHook ?? null,
    cleanupHook: record.cleanupHook ?? null,
    setupOutputFile: record.setupOutputFile ?? null,
    cleanupOutputFile: record.cleanupOutputFile ?? null,
    backendSessionId: record.backendSessionId ?? null,
    setupRan: record.setupRan,
    resuming: record.resuming,
    baselineStatus: record.baselineStatus ?? null,
    lastExitStatus: record.lastExitStatus ?? null,
    executionId: record.executionId ?? null,
    executionPid: record.executionPid ?? null,
    executionStartedAt: record.executionStartedAt ?? null,
    executionOwnerPid: record.executionOwnerPid ?? null,
    executionOwnerStartedAt: record.executionOwnerStartedAt ?? null,
    updatedAt: record.lastActivityAt,
  };
}

function toAgentSession(row: AgentSessionRow): AgentSession {
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
    lastActivityAt: row.updatedAt,
  });
}

const legacySessionTimestampKeys = new Set(["createdAt", "updatedAt"]);

/**
 * Restores a receipt session snapshot, tolerating snapshots written before
 * bookkeeping timestamps left the entity shape. Receipts are transient so
 * this tolerance expires with them; it is not a compatibility alias.
 */
function restoreReceiptSession(input: unknown): AgentSession {
  if (typeof input !== "object" || input === null) return AgentSession.restore(input);
  const record: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!legacySessionTimestampKeys.has(key)) record[key] = value;
  }
  return AgentSession.restore(record);
}

function toAgentExecutionReceipt(row: typeof agentExecutionReceipts.$inferSelect): AgentExecutionReceipt {
  const process = JSON.parse(row.process) as AgentExecutionReceipt["process"];
  const session = restoreReceiptSession(JSON.parse(row.session));
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
