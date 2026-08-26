import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveMuximodPaths } from "@muximo/infrastructure";

export type DevStateSnapshotter = (sourceDatabaseFile: string, targetDatabaseFile: string) => void;

export function ensureDevMuximodState(
  environment: NodeJS.ProcessEnv = process.env,
  snapshot: DevStateSnapshotter = snapshotSqliteDatabase,
): void {
  const targetPaths = resolveMuximodPaths(environment);
  if (targetPaths.databaseFile === ":memory:" || existsSync(targetPaths.databaseFile)) return;

  const baseDirectory = environment.BASE_MUXIMOD_INSTANCE_DIR?.trim();
  if (!baseDirectory) return;

  const sourcePaths = resolveMuximodPaths({
    ...environment,
    MUXIMOD_INSTANCE_DIR: resolve(baseDirectory),
    MUXIMOD_DB_FILE: undefined,
    MUXIMO_DATABASE_FILE: undefined,
  });
  if (sourcePaths.databaseFile === ":memory:" || !existsSync(sourcePaths.databaseFile)) {
    throw new Error(`base muximod database was not found: ${sourcePaths.databaseFile}`);
  }

  const targetDirectory = dirname(targetPaths.databaseFile);
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  chmodSync(targetDirectory, 0o700);
  const temporaryDirectory = mkdtempSync(join(targetDirectory, ".muximod-bootstrap-"));
  const temporaryDatabaseFile = join(temporaryDirectory, basename(targetPaths.databaseFile));

  try {
    snapshot(sourcePaths.databaseFile, temporaryDatabaseFile);
    verifySqliteDatabase(temporaryDatabaseFile);
    if (!existsSync(targetPaths.databaseFile)) {
      renameSync(temporaryDatabaseFile, targetPaths.databaseFile);
      chmodSync(targetPaths.databaseFile, 0o600);
    }
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function snapshotSqliteDatabase(sourceDatabaseFile: string, targetDatabaseFile: string): void {
  const source = new Database(sourceDatabaseFile);
  try {
    source.exec(`PRAGMA busy_timeout = 1000; VACUUM INTO '${quoteSqlString(targetDatabaseFile)}';`);
  } finally {
    source.close();
  }
}

function verifySqliteDatabase(databaseFile: string): void {
  const database = new Database(databaseFile, { readonly: true });
  try {
    const result = database.query("PRAGMA integrity_check").get() as { integrity_check?: string } | null;
    if (result?.integrity_check !== "ok") {
      throw new Error(`SQLite integrity check failed for ${databaseFile}: ${result?.integrity_check ?? "unknown"}`);
    }
  } finally {
    database.close();
  }
}

function quoteSqlString(value: string): string {
  return value.replaceAll("'", "''");
}
