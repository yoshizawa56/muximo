import type { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentDrizzleDatabase } from "./database-types.js";

export type SqliteTransactionScope = {
  owner: object;
  rootDatabase: AgentDrizzleDatabase;
  rootSqlite: Database;
  database: AgentDrizzleDatabase;
  sqlite: Database;
};

const storage = new AsyncLocalStorage<SqliteTransactionScope>();

export function currentSqliteTransaction(): SqliteTransactionScope | undefined {
  return storage.getStore();
}

export function ambientDatabase(root: AgentDrizzleDatabase): AgentDrizzleDatabase {
  const scope = storage.getStore();
  if (!scope) return root;
  if (scope.rootDatabase !== root) throw new Error("SQLite transaction database identity mismatch");
  return scope.database;
}

export function ambientSqlite(root: Database): Database {
  const scope = storage.getStore();
  if (!scope) return root;
  if (scope.rootSqlite !== root) throw new Error("SQLite transaction database identity mismatch");
  return scope.sqlite;
}

export function assertSqliteTransactionIdentity(
  scope: SqliteTransactionScope,
  rootDatabase: AgentDrizzleDatabase,
  rootSqlite: Database,
): void {
  if (scope.rootDatabase !== rootDatabase || scope.rootSqlite !== rootSqlite)
    throw new Error("SQLite transaction database identity mismatch");
}

export function runWithSqliteTransaction<T>(scope: SqliteTransactionScope, operation: () => Promise<T>): Promise<T> {
  const current = storage.getStore();
  if (current) {
    if (current.owner !== scope.owner) throw new Error("SQLite transaction owner mismatch");
    if (current.rootDatabase !== scope.rootDatabase || current.rootSqlite !== scope.rootSqlite)
      throw new Error("SQLite transaction database identity mismatch");
  }
  return storage.run(scope, operation);
}
