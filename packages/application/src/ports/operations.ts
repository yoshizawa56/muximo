import type {
  OperationError,
  OperationExecutor,
  OperationId,
  OperationRecord,
  OperationState,
  OperationSubject,
} from "@muximo/domain";

export type OperationStartInput = {
  kind: string;
  executor: OperationExecutor;
  requestFingerprint: string;
  idempotencyKey?: string;
};

export type OperationAllocation = {
  operation: OperationRecord;
  created: boolean;
};

/** Public operation data. Request identity and internal executor details stay daemon-owned. */
export type OperationStatus = Omit<
  OperationRecord,
  "id" | "executor" | "requestFingerprint" | "idempotencyKey" | "subject"
> & {
  operationId: string;
};

export type OperationFailure = {
  error: OperationError;
  diagnostic?: string;
  logReference?: string;
  result?: unknown;
};

export interface OperationRepository {
  findById(id: OperationId): Promise<OperationRecord | undefined>;
  findByIdempotencyKey(kind: string, idempotencyKey: string): Promise<OperationRecord | undefined>;
  insertIfAbsent(operation: OperationRecord): Promise<boolean>;
  /** Returns false when the persisted record changed since expectedUpdatedAt. */
  update(operation: OperationRecord, expectedUpdatedAt?: string): Promise<boolean>;
  listActive(): Promise<OperationRecord[]>;
  deleteCompletedBefore(before: string): Promise<number>;
}

export type OperationClock = {
  now(): string;
  id(): string;
};

export type OperationApplication = {
  get(operationId: string): Promise<OperationStatus>;
  cancel(operationId: string): Promise<OperationStatus>;
};

export type OperationResultState = Extract<OperationState, "succeeded" | "failed" | "cancelled">;

export class OperationNotFoundError extends Error {
  public readonly code = "operation_not_found" as const;

  public constructor(public readonly operationId: string) {
    super(`operation not found: ${operationId}`);
    this.name = "OperationNotFoundError";
  }
}

export class OperationIdempotencyConflictError extends Error {
  public readonly code = "operation_idempotency_conflict" as const;

  public constructor(public readonly operationId: string) {
    super(`idempotency key is already associated with a different request: ${operationId}`);
    this.name = "OperationIdempotencyConflictError";
  }
}

export class OperationAlreadyStartedError extends Error {
  public readonly code = "operation_already_started" as const;

  public constructor(
    public readonly operationId: string,
    public readonly state: OperationState,
  ) {
    super(`operation has already started: ${operationId}`);
    this.name = "OperationAlreadyStartedError";
  }
}

export class OperationCancelledError extends Error {
  public readonly code = "operation_cancelled" as const;

  public constructor() {
    super("operation was cancelled");
    this.name = "OperationCancelledError";
  }
}

export class OperationExecutionMismatchError extends Error {
  public readonly code = "operation_execution_mismatch" as const;

  public constructor(public readonly operationId: string) {
    super(`operation does not match the requested agent execution: ${operationId}`);
    this.name = "OperationExecutionMismatchError";
  }
}

export type OperationResourceSubject = OperationSubject;
