import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveMuximodPaths } from "@muximo/infrastructure";

export type DevStateSnapshotter = (sourceDatabaseFile: string, targetDatabaseFile: string) => void;

const bootstrapLockTimeoutMs = 15_000;
const bootstrapPollIntervalMs = 25;
const bootstrapWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

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

  const lockFile = `${targetPaths.databaseFile}.bootstrap.lock`;
  while (!existsSync(targetPaths.databaseFile)) {
    const lockHandle = tryAcquireBootstrapLock(lockFile);
    if (lockHandle === undefined) {
      waitForBootstrap(targetPaths.databaseFile, lockFile);
      continue;
    }

    try {
      if (existsSync(targetPaths.databaseFile)) return;

      const temporaryDirectory = mkdtempSync(join(targetDirectory, ".muximod-bootstrap-"));
      const temporaryDatabaseFile = join(temporaryDirectory, basename(targetPaths.databaseFile));
      try {
        snapshot(sourcePaths.databaseFile, temporaryDatabaseFile);
        scrubAuthenticationState(temporaryDatabaseFile);
        verifySqliteDatabase(temporaryDatabaseFile);
        chmodSync(temporaryDatabaseFile, 0o600);
        try {
          // The temporary file is in the target directory, so a hard link
          // publishes the complete snapshot without replacing a concurrent
          // target file.
          linkSync(temporaryDatabaseFile, targetPaths.databaseFile);
          chmodSync(targetPaths.databaseFile, 0o600);
        } catch (error) {
          if (!hasErrorCode(error, "EEXIST")) throw error;
        }
      } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
      return;
    } finally {
      releaseBootstrapLock(lockHandle, lockFile);
    }
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

function scrubAuthenticationState(databaseFile: string): void {
  const database = new Database(databaseFile);
  try {
    database.exec(`
      DROP TABLE IF EXISTS auth_sessions;
      DROP TABLE IF EXISTS auth_pairings;
      DROP TABLE IF EXISTS auth_devices;
      DROP TABLE IF EXISTS auth_metadata;
    `);
  } finally {
    database.close();
  }
}

function tryAcquireBootstrapLock(lockFile: string): number | undefined {
  try {
    return openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if (hasErrorCode(error, "EEXIST")) return undefined;
    throw error;
  }
}

function waitForBootstrap(databaseFile: string, lockFile: string): void {
  const deadline = Date.now() + bootstrapLockTimeoutMs;
  while (existsSync(lockFile) && !existsSync(databaseFile)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for muximod state bootstrap lock: ${lockFile}`);
    }
    Atomics.wait(bootstrapWaitBuffer, 0, 0, bootstrapPollIntervalMs);
  }
}

function releaseBootstrapLock(lockHandle: number, lockFile: string): void {
  closeSync(lockHandle);
  try {
    unlinkSync(lockFile);
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
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
