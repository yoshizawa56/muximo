import type { OperationRepository } from "@muximo/application";
import { Operation, OperationId, type OperationRecord } from "@muximo/domain";
import { and, eq, inArray, lt } from "drizzle-orm";
import { type OperationRow, operations } from "../../schema.js";
import { DrizzleRepositoryBase } from "./base.js";

export class DrizzleOperationRepository extends DrizzleRepositoryBase implements OperationRepository {
  public async findById(id: OperationId): Promise<OperationRecord | undefined> {
    const row = this.db().select().from(operations).where(eq(operations.id, id)).get();
    return row ? toOperationRecord(row) : undefined;
  }

  public async findByIdempotencyKey(kind: string, idempotencyKey: string): Promise<OperationRecord | undefined> {
    const row = this.db()
      .select()
      .from(operations)
      .where(and(eq(operations.kind, kind), eq(operations.idempotencyKey, idempotencyKey)))
      .get();
    return row ? toOperationRecord(row) : undefined;
  }

  public async insertIfAbsent(operation: OperationRecord): Promise<boolean> {
    try {
      this.db().insert(operations).values(toOperationRow(operation)).run();
      return true;
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }
  }

  public async update(operation: OperationRecord, expectedUpdatedAt?: string): Promise<boolean> {
    const predicate =
      expectedUpdatedAt === undefined
        ? eq(operations.id, operation.id)
        : and(eq(operations.id, operation.id), eq(operations.updatedAt, expectedUpdatedAt));
    const result = this.db()
      .update(operations)
      .set(toOperationRow(operation))
      .where(predicate)
      .returning({ id: operations.id })
      .all();
    return result.length > 0;
  }

  public async listActive(): Promise<OperationRecord[]> {
    const rows = this.db()
      .select()
      .from(operations)
      .where(inArray(operations.state, ["queued", "running"]))
      .all();
    return rows.map(toOperationRecord);
  }

  public async deleteCompletedBefore(before: string): Promise<number> {
    const expired = this.db()
      .select({ id: operations.id })
      .from(operations)
      .where(and(inArray(operations.state, ["succeeded", "failed", "cancelled"]), lt(operations.completedAt, before)))
      .all();
    for (const operation of expired) this.db().delete(operations).where(eq(operations.id, operation.id)).run();
    return expired.length;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint|constraint failed/iu.test(error.message);
}

function toOperationRow(operation: OperationRecord): typeof operations.$inferInsert {
  const current = Operation.restore(operation);
  return {
    id: current.id,
    kind: current.kind,
    executor: current.executor,
    state: current.state,
    requestFingerprint: current.requestFingerprint,
    idempotencyKey: current.idempotencyKey ?? null,
    subject: current.subject === undefined ? null : JSON.stringify(current.subject),
    result: current.result === undefined ? null : JSON.stringify(current.result),
    error: current.error === undefined ? null : JSON.stringify(current.error),
    diagnostic: current.diagnostic ?? null,
    logReference: current.logReference ?? null,
    cancelRequestedAt: current.cancelRequestedAt ?? null,
    startedAt: current.startedAt ?? null,
    completedAt: current.completedAt ?? null,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
  };
}

function toOperationRecord(row: OperationRow): OperationRecord {
  return Operation.restore({
    id: OperationId.create(row.id),
    kind: row.kind,
    executor: row.executor,
    state: row.state,
    requestFingerprint: row.requestFingerprint,
    ...(row.idempotencyKey === null ? {} : { idempotencyKey: row.idempotencyKey }),
    ...(row.subject === null ? {} : { subject: JSON.parse(row.subject) }),
    ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
    ...(row.startedAt === null ? {} : { startedAt: row.startedAt }),
    ...(row.completedAt === null ? {} : { completedAt: row.completedAt }),
    updatedAt: row.updatedAt,
    ...(row.result === null ? {} : { result: JSON.parse(row.result) }),
    ...(row.error === null ? {} : { error: JSON.parse(row.error) }),
    ...(row.diagnostic === null ? {} : { diagnostic: row.diagnostic }),
    ...(row.logReference === null ? {} : { logReference: row.logReference }),
    ...(row.cancelRequestedAt === null ? {} : { cancelRequestedAt: row.cancelRequestedAt }),
  });
}
