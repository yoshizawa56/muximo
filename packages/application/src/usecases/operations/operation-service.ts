import {
  Operation,
  type OperationError,
  OperationId,
  type OperationRecord,
  type OperationState,
  type OperationSubject,
} from "@muximo/domain";
import {
  type OperationAllocation,
  OperationAlreadyStartedError,
  type OperationClock,
  OperationExecutionMismatchError,
  type OperationFailure,
  OperationIdempotencyConflictError,
  OperationNotFoundError,
  type OperationRepository,
  type OperationStartInput,
  type OperationStatus,
} from "../../ports/operations.js";

export type OperationServiceDependencies = {
  repository: OperationRepository;
  clock: OperationClock;
};

/** Owns durable operation state transitions independently from any transport. */
export class OperationService {
  private readonly cancellationControllers = new Map<string, AbortController>();

  public constructor(private readonly deps: OperationServiceDependencies) {}

  public async create(input: OperationStartInput): Promise<OperationAllocation> {
    const requestFingerprint = canonicalizeFingerprint(input.requestFingerprint);
    if (input.idempotencyKey !== undefined) {
      const existing = await this.deps.repository.findByIdempotencyKey(input.kind, input.idempotencyKey);
      if (existing) return this.reconcileExisting(existing, requestFingerprint);
    }

    const now = this.deps.clock.now();
    const operation = Operation.create({
      id: OperationId.create(this.deps.clock.id()),
      kind: input.kind,
      executor: input.executor,
      requestFingerprint,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      createdAt: now,
      updatedAt: now,
    });
    if (await this.deps.repository.insertIfAbsent(operation)) return { operation, created: true };

    const existing =
      input.idempotencyKey === undefined
        ? await this.deps.repository.findById(operation.id)
        : await this.deps.repository.findByIdempotencyKey(input.kind, input.idempotencyKey);
    if (!existing) throw new Error("operation could not be persisted");
    return this.reconcileExisting(existing, requestFingerprint);
  }

  public async start(operationId: string, subject?: OperationSubject): Promise<OperationStatus> {
    const current = await this.require(operationId);
    if (current.state === "running") return toStatus(current);
    if (current.state !== "queued") throw new OperationAlreadyStartedError(operationId, current.state);
    const next = Operation.start(current, this.deps.clock.now(), subject);
    return toStatus(await this.commit(current, next));
  }

  public async setSubject(operationId: string, subject: OperationSubject): Promise<OperationStatus> {
    const current = await this.require(operationId);
    const next = Operation.setSubject(current, subject, this.deps.clock.now());
    return toStatus(await this.commit(current, next));
  }

  public async succeed(operationId: string, result: unknown): Promise<OperationStatus> {
    return toStatus(await this.commitTerminal(operationId, (current, now) => Operation.succeed(current, now, result)));
  }

  public async fail(
    operationId: string,
    failure: unknown,
    diagnostic?: string,
    logReference?: string,
    result?: unknown,
  ): Promise<OperationStatus> {
    const normalized = normalizeFailure(failure, diagnostic, logReference);
    return toStatus(
      await this.commitTerminal(operationId, (current, now) =>
        Operation.fail(current, now, normalized.error, normalized.diagnostic, normalized.logReference, result),
      ),
    );
  }

  public async cancel(operationId: string): Promise<OperationStatus> {
    const persisted = await this.commitTerminal(operationId, (current, now) =>
      Operation.requestCancellation(current, now),
    );
    this.cancellationControllers.get(operationId)?.abort(new Error("operation cancellation requested"));
    return toStatus(persisted);
  }

  public async finishCancellation(operationId: string, result?: unknown): Promise<OperationStatus> {
    return toStatus(
      await this.commitTerminal(operationId, (current, now) =>
        current.state === "queued"
          ? Operation.requestCancellation(current, now, result)
          : Operation.cancel(current, now, result),
      ),
    );
  }

  public async get(operationId: string): Promise<OperationStatus> {
    return toStatus(await this.require(operationId));
  }

  public async find(operationId: string): Promise<OperationRecord | undefined> {
    return this.deps.repository.findById(OperationId.create(operationId));
  }

  public async validateAgentExecution(
    operationId: string,
    operation: "run" | "resume",
    agentSessionId: string,
    executionId: string,
  ): Promise<OperationRecord> {
    const current = await this.require(operationId);
    const expectedKind = operation === "run" ? "agent_session.run" : "agent_session.resume";
    if (
      current.executor !== "client" ||
      current.kind !== expectedKind ||
      current.subject?.type !== "agent_session" ||
      current.subject.id !== agentSessionId ||
      current.subject.executionId !== executionId
    ) {
      throw new OperationExecutionMismatchError(operationId);
    }
    return current;
  }

  public async listActive(): Promise<OperationRecord[]> {
    return this.deps.repository.listActive();
  }

  public registerCancellation(operationId: string, controller: AbortController): void {
    this.cancellationControllers.set(operationId, controller);
  }

  public unregisterCancellation(operationId: string, controller: AbortController): void {
    if (this.cancellationControllers.get(operationId) === controller) this.cancellationControllers.delete(operationId);
  }

  /** Marks daemon-owned work as interrupted; client-owned executions may survive a daemon restart. */
  public async recoverDaemonOperations(): Promise<void> {
    const active = await this.deps.repository.listActive();
    for (const operation of active) {
      if (operation.executor !== "daemon") continue;
      await this.fail(
        operation.id,
        {
          code: "muximod_restarted",
          message: "muximod restarted before the daemon-owned operation completed",
        },
        "The daemon-owned operation was interrupted by a muximod restart",
      );
    }
  }

  public async deleteExpired(before: string): Promise<number> {
    return this.deps.repository.deleteCompletedBefore(before);
  }

  private async commit(current: OperationRecord, next: OperationRecord): Promise<OperationRecord> {
    if (await this.deps.repository.update(next, current.updatedAt)) return next;
    const latest = await this.require(current.id);
    if (isTerminal(latest.state)) return latest;
    throw new Error(`operation was concurrently updated: ${current.id}`);
  }

  private async commitTerminal(
    operationId: string,
    transition: (current: OperationRecord, now: string) => OperationRecord,
  ): Promise<OperationRecord> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.require(operationId);
      if (isTerminal(current.state)) return current;
      const next = transition(current, this.deps.clock.now());
      if (await this.deps.repository.update(next, current.updatedAt)) return next;
    }
    const latest = await this.require(operationId);
    if (isTerminal(latest.state)) return latest;
    throw new Error(`operation was concurrently updated: ${operationId}`);
  }

  private async require(operationId: string): Promise<OperationRecord> {
    const operation = await this.deps.repository.findById(OperationId.create(operationId));
    if (!operation) throw new OperationNotFoundError(operationId);
    return operation;
  }

  private reconcileExisting(operation: OperationRecord, requestFingerprint: string): OperationAllocation {
    if (operation.requestFingerprint !== requestFingerprint) {
      throw new OperationIdempotencyConflictError(operation.id);
    }
    return { operation, created: false };
  }
}

function isTerminal(state: OperationState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function toStatus(operation: OperationRecord): OperationStatus {
  const {
    id,
    executor: _executor,
    requestFingerprint: _requestFingerprint,
    idempotencyKey: _idempotencyKey,
    subject: _subject,
    ...publicFields
  } = operation;
  return { ...publicFields, operationId: id };
}

function normalizeFailure(failure: unknown, diagnostic?: string, logReference?: string): OperationFailure {
  const value = isRecord(failure) ? failure : undefined;
  const code = typeof value?.code === "string" && value.code.trim() ? value.code.trim() : "operation_failed";
  const message =
    typeof value?.message === "string" && value.message.trim()
      ? value.message.trim().slice(0, 4_096)
      : "The operation failed";
  const details = isRecord(value?.details) ? value.details : undefined;
  const normalizedError: OperationError = {
    code: code.slice(0, 120),
    message,
    ...(details === undefined ? {} : { details }),
  };
  const failureDiagnostic =
    diagnostic ?? (typeof value?.failureDiagnostic === "string" ? value.failureDiagnostic : undefined);
  return {
    error: normalizedError,
    ...(failureDiagnostic === undefined ? {} : { diagnostic: failureDiagnostic.slice(0, 4_096) }),
    ...(logReference === undefined ? {} : { logReference: logReference.slice(0, 4_096) }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function canonicalizeFingerprint(value: string): string {
  try {
    return stableStringify(JSON.parse(value));
  } catch {
    return value;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
