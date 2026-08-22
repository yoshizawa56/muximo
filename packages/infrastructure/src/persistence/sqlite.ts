import type { Database } from "bun:sqlite";

export const defaultSqliteBusyTimeoutMs = 1_000;

export function configureSqliteConnection(
  sqlite: Database,
  busyTimeoutMs: number = defaultSqliteBusyTimeoutMs,
): Database {
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
    throw new Error("SQLite busy timeout must be a non-negative integer");
  }

  sqlite.exec([
    "PRAGMA foreign_keys = ON",
    "PRAGMA journal_mode = WAL",
    `PRAGMA busy_timeout = ${busyTimeoutMs}`,
  ].join("; "));
  return sqlite;
}
