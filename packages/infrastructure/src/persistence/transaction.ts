import type { Database } from "bun:sqlite";
import type { TransactionManager } from "@muximo/application";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { AgentDatabase } from "./index.js";
import {
  currentSqliteTransaction,
  runWithSqliteTransaction,
  type SqliteTransactionScope,
} from "./transaction-context.js";

export type SqliteRetryOptions = {
  maxRetries?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  random?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

const defaultRetryOptions: Required<Pick<SqliteRetryOptions, "maxRetries" | "retryDelayMs" | "maxRetryDelayMs">> = {
  maxRetries: 3,
  retryDelayMs: 10,
  maxRetryDelayMs: 250,
};

/**
 * Keeps an application-owned async DB-only scope on a dedicated connection.
 * This explicit BEGIN/COMMIT path is intentional; it is not Bun's unsafe
 * `Database.transaction(async callback)` form. The mutex protects this
 * connection in-process, while SQLite busy handling remains responsible for
 * writers in other processes such as the direct CLI.
 */
export class SqliteTransactionManager implements TransactionManager {
  private readonly mutex = new AsyncMutex();
  private readonly sqlite: Database;
  private readonly database: ReturnType<typeof drizzle>;
  private closed = false;

  public constructor(
    readonly root: AgentDatabase,
    private readonly options: SqliteRetryOptions = {},
  ) {
    if (root.databaseFile === ":memory:") {
      throw new Error("SqliteTransactionManager requires a file-backed database");
    }
    this.sqlite = root.openConnection();
    this.database = drizzle({ client: this.sqlite });
  }

  public async run<Result>(operation: () => Promise<Result>): Promise<Result> {
    const current = currentSqliteTransaction();
    if (current?.owner === this) return operation();
    if (current) throw new Error("SQLite transaction owner mismatch");
    if (this.closed) throw new Error("SQLite transaction manager is closed");

    const release = await this.mutex.acquire();
    try {
      return await this.runWithRetry(operation);
    } finally {
      release();
    }
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.sqlite.close();
  }

  private async runWithRetry<Result>(operation: () => Promise<Result>): Promise<Result> {
    const maxRetries = this.options.maxRetries ?? defaultRetryOptions.maxRetries;
    for (let attempt = 0; ; attempt += 1) {
      let started = false;
      try {
        this.sqlite.exec("BEGIN IMMEDIATE");
        started = true;
        const scope: SqliteTransactionScope = {
          owner: this,
          rootDatabase: this.root.db,
          rootSqlite: this.root.sqlite,
          database: this.database,
          sqlite: this.sqlite,
        };
        const result = await runWithSqliteTransaction(scope, operation);
        this.sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        if (started) rollbackQuietly(this.sqlite);
        if (!isRetryableSqliteBusy(error) || attempt >= maxRetries) throw error;
        await this.waitBeforeRetry(attempt);
      }
    }
  }

  private async waitBeforeRetry(attempt: number): Promise<void> {
    const base = this.options.retryDelayMs ?? defaultRetryOptions.retryDelayMs;
    const maximum = this.options.maxRetryDelayMs ?? defaultRetryOptions.maxRetryDelayMs;
    const random = this.options.random ?? Math.random;
    const exponential = Math.min(maximum, base * 2 ** attempt);
    const jitter = Math.floor(exponential * 0.25 * random());
    const delay = Math.min(maximum, exponential + jitter);
    const sleep = this.options.sleep ?? defaultSleep;
    await sleep(delay);
  }
}

/**
 * Synchronous-only transaction helper for adapters whose entire operation is
 * synchronous. Never pass a Promise-returning callback here: Bun's
 * `Database.transaction` cannot keep a transaction open across an await.
 */
export function runSqliteTransaction<Result>(
  sqlite: Database,
  operation: () => Result,
  options: SqliteRetryOptions = {},
): Result {
  const maxRetries = options.maxRetries ?? defaultRetryOptions.maxRetries;
  const transaction = sqlite.transaction(operation).immediate;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return transaction();
    } catch (error) {
      rollbackQuietly(sqlite);
      if (!isRetryableSqliteBusy(error) || attempt >= maxRetries) throw error;
    }
  }
}

export function isRetryableSqliteBusy(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown };
  if (candidate.errno === 5) return true;
  if (typeof candidate.code === "string" && candidate.code.startsWith("SQLITE_BUSY")) return true;
  return typeof candidate.message === "string" && /(?:SQLITE_BUSY|database is locked)/i.test(candidate.message);
}

function rollbackQuietly(sqlite: Database): void {
  try {
    sqlite.exec("ROLLBACK");
  } catch {
    // Preserve the transaction operation error. The connection is reused only
    // after the rollback attempt has completed.
  }
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

class AsyncMutex {
  private tail = Promise.resolve();

  public acquire(): Promise<() => void> {
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => current);

    return previous.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseCurrent();
      };
    });
  }
}
