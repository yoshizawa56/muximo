import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "bun:sqlite";
import type { AgentDrizzleDatabase } from "./database-types.js";

export type SqliteTransactionScope = {
  owner: object;
  database: AgentDrizzleDatabase;
  sqlite: Database;
};

const storage = new AsyncLocalStorage<SqliteTransactionScope>();

export function currentSqliteTransaction(): SqliteTransactionScope | undefined {
  return storage.getStore();
}

export function ambientDatabase(root: AgentDrizzleDatabase): AgentDrizzleDatabase {
  return storage.getStore()?.database ?? root;
}

export function ambientSqlite(root: Database): Database {
  return storage.getStore()?.sqlite ?? root;
}

export function runWithSqliteTransaction<T>(
  scope: SqliteTransactionScope,
  operation: () => Promise<T>,
): Promise<T> {
  return storage.run(scope, operation);
}
