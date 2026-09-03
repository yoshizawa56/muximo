import { z } from "zod";
import { OperationId, type OperationId as OperationIdValue } from "./ids.js";

export const operationStates = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export const operationStateSchema = z.enum(operationStates);
export type OperationState = z.infer<typeof operationStateSchema>;

export const operationExecutors = ["client", "daemon"] as const;
export const operationExecutorSchema = z.enum(operationExecutors);
export type OperationExecutor = z.infer<typeof operationExecutorSchema>;

const operationKindSchema = z.string().trim().min(1).max(120);
const operationFingerprintSchema = z
  .string()
  .min(1)
  .max(64 * 1024);
const operationIdempotencyKeySchema = z.string().trim().min(1).max(256);
const operationSubjectSchema = z
  .object({
    type: z.string().trim().min(1).max(120),
    id: z.string().trim().min(1).max(256),
    executionId: z.string().trim().min(1).max(256).optional(),
  })
  .strict();
const operationErrorSchema = z
  .object({
    code: z.string().trim().min(1).max(120),
    message: z.string().trim().min(1).max(4_096),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const operationSchema = z
  .object({
    id: OperationId.schema,
    kind: operationKindSchema,
    executor: operationExecutorSchema,
    state: operationStateSchema,
    requestFingerprint: operationFingerprintSchema,
    idempotencyKey: operationIdempotencyKeySchema.optional(),
    subject: operationSubjectSchema.optional(),
    createdAt: z.string().min(1),
    startedAt: z.string().min(1).optional(),
    completedAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
    result: z.unknown().optional(),
    error: operationErrorSchema.optional(),
    diagnostic: z.string().trim().min(1).max(4_096).optional(),
    logReference: z.string().trim().min(1).max(4_096).optional(),
    cancelRequestedAt: z.string().min(1).optional(),
  })
  .strict();

export type Operation = z.infer<typeof operationSchema>;
export type OperationRecord = Operation;

export type OperationCreateInput = {
  id: OperationIdValue;
  kind: string;
  executor: OperationExecutor;
  requestFingerprint: string;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
};

export type OperationSubject = z.infer<typeof operationSubjectSchema>;
export type OperationError = z.infer<typeof operationErrorSchema>;

export class InvalidOperationTransitionError extends Error {
  public readonly code = "invalid_operation_transition" as const;

  public constructor(
    public readonly operationId: OperationIdValue,
    from: OperationState,
    to: OperationState,
  ) {
    super(`operation '${operationId}' cannot transition from ${from} to ${to}`);
    this.name = "InvalidOperationTransitionError";
  }
}

const parseOperation = (input: unknown): Operation => operationSchema.parse(input);

export const Operation = {
  schema: operationSchema,

  /** Rehydrates a persisted operation. This is the only re-entry point for raw data. */
  restore(input: unknown): Operation {
    return parseOperation(input);
  },

  create(input: OperationCreateInput): Operation {
    return parseOperation({
      id: input.id,
      kind: input.kind,
      executor: input.executor,
      state: "queued",
      requestFingerprint: input.requestFingerprint,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    });
  },

  start(entity: Operation, now: string, subject?: OperationSubject): Operation {
    const current = parseOperation(entity);
    requireState(current, "running");
    return parseOperation({
      ...current,
      state: "running",
      startedAt: now,
      updatedAt: now,
      ...(subject === undefined ? {} : { subject }),
    });
  },

  setSubject(entity: Operation, subject: OperationSubject, now: string): Operation {
    const current = parseOperation(entity);
    if (current.state !== "queued" && current.state !== "running") {
      throw new InvalidOperationTransitionError(current.id, current.state, current.state);
    }
    return parseOperation({ ...current, subject, updatedAt: now });
  },

  succeed(entity: Operation, now: string, result: unknown): Operation {
    const current = parseOperation(entity);
    requireState(current, "succeeded");
    return parseOperation({
      ...current,
      state: "succeeded",
      completedAt: now,
      updatedAt: now,
      result,
    });
  },

  fail(
    entity: Operation,
    now: string,
    error: OperationError,
    diagnostic?: string,
    logReference?: string,
    result?: unknown,
  ): Operation {
    const current = parseOperation(entity);
    requireState(current, "failed");
    return parseOperation({
      ...current,
      state: "failed",
      completedAt: now,
      updatedAt: now,
      error,
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(logReference === undefined ? {} : { logReference }),
      ...(result === undefined ? {} : { result }),
    });
  },

  requestCancellation(entity: Operation, now: string, result?: unknown): Operation {
    const current = parseOperation(entity);
    if (current.state === "queued") {
      return parseOperation({
        ...current,
        state: "cancelled",
        completedAt: now,
        updatedAt: now,
        cancelRequestedAt: now,
        ...(result === undefined ? {} : { result }),
      });
    }
    if (current.state !== "running") return current;
    if (current.cancelRequestedAt !== undefined) return current;
    return parseOperation({ ...current, cancelRequestedAt: now, updatedAt: now });
  },

  cancel(entity: Operation, now: string, result?: unknown): Operation {
    const current = parseOperation(entity);
    requireState(current, "cancelled");
    return parseOperation({
      ...current,
      state: "cancelled",
      completedAt: now,
      updatedAt: now,
      cancelRequestedAt: current.cancelRequestedAt ?? now,
      ...(result === undefined ? {} : { result }),
    });
  },
} as const;

function requireState(entity: Operation, target: OperationState): void {
  if (entity.state === "queued" && target === "running") return;
  if (entity.state === "queued" && target === "failed") return;
  if (entity.state === "running" && (target === "succeeded" || target === "failed" || target === "cancelled")) return;
  throw new InvalidOperationTransitionError(entity.id, entity.state, target);
}
