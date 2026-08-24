import type { CaseScope } from "@muximo/test-support";
import { drizzle } from "drizzle-orm/bun-sqlite";
import type { AgentDatabase } from "../index.js";
import { runWithSqliteTransaction, type SqliteTransactionScope } from "../transaction-context.js";

/**
 * Creates one migration-once, serial per-case scope for SQLite table tests.
 * Each case uses a dedicated connection and always rolls back after the table
 * runner has finished fixture setup, execution, observation, and assertions.
 */
export function createSqliteRollbackScope(root: AgentDatabase): { caseScope: CaseScope; close: () => void } {
  const sqlite = root.openConnection();
  const database = drizzle({ client: sqlite });
  const owner = {};
  let tail = Promise.resolve();
  let closed = false;

  const caseScope: CaseScope = async <Result>(operation: () => Result | PromiseLike<Result>): Promise<Result> => {
    if (closed) throw new Error("SQLite test scope is closed");
    const release = await acquire();
    try {
      sqlite.exec("BEGIN IMMEDIATE");
      const scope: SqliteTransactionScope = {
        owner,
        rootDatabase: root.db,
        rootSqlite: root.sqlite,
        database,
        sqlite,
      };
      try {
        const result = await runWithSqliteTransaction(scope, async () => await operation());
        rollback(sqlite);
        return result;
      } catch (error) {
        rollback(sqlite);
        throw error;
      }
    } finally {
      release();
    }
  };

  return {
    caseScope,
    close: () => {
      if (closed) return;
      closed = true;
      sqlite.close();
    },
  };

  async function acquire(): Promise<() => void> {
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const previous = tail;
    tail = previous.then(() => current);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseCurrent();
    };
  }
}

function rollback(sqlite: { exec(sql: string): unknown }): void {
  try {
    sqlite.exec("ROLLBACK");
  } catch {
    // Preserve the operation or assertion error if the connection is already
    // outside a transaction.
  }
}
