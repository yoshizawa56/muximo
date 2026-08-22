import type { WorkspaceId } from "@muximo/domain";

export type WorkspaceDirectoryInfo = {
  id: WorkspaceId;
  rootPath: string;
  name: string;
  isGit: boolean;
};

/**
 * Host-specific filesystem and repository checks required by workspace CRUD.
 * The application layer owns mutation rules; adapters own path resolution and
 * executable-file checks.
 */
export interface WorkspaceDirectoryPort {
  resolveDirectory(directory: string): WorkspaceDirectoryInfo | Promise<WorkspaceDirectoryInfo>;
  resolveHook(path: string, workspaceRoot: string): string | Promise<string>;
}

/**
 * Database-only audit persistence when called inside a TransactionManager
 * scope. Network, filesystem, and other external effects must not implement
 * this callback for a transactional workspace mutation.
 */
export interface WorkspaceAuditPort {
  record(eventType: string, entityId: string, payload: unknown): void | Promise<void>;
}
