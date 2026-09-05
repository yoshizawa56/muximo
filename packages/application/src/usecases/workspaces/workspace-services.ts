import type { Workspace, WorkspaceId, WorkspaceSelection } from "@muximo/domain";
import { Context, Effect, Layer } from "effect";
import type { ApplicationEffect } from "../../effect.js";
import type { MuximodWorkspaceDirectory } from "../../ports/application.js";
import type { WorkspaceDirectoryInfo } from "../../ports/workspace.js";

export interface WorkspaceRepository {
  findById(id: WorkspaceId): ApplicationEffect<Workspace | undefined>;
  list(): ApplicationEffect<Workspace[]>;
  insert(record: Workspace): ApplicationEffect<boolean>;
  upsert(record: Workspace): ApplicationEffect<void>;
  delete(id: WorkspaceId): ApplicationEffect<void>;
}

export interface WorkspaceDirectory {
  resolveDirectory(directory: string): ApplicationEffect<WorkspaceDirectoryInfo>;
  resolveHook(path: string, workspaceRoot: string): ApplicationEffect<string>;
}

export interface WorkspaceAudit {
  record(eventType: string, entityId: string, payload: unknown): ApplicationEffect<void>;
}

export interface TransactionManager {
  run<A>(operation: ApplicationEffect<A>): ApplicationEffect<A>;
}

export interface MuximodWorkspaceCatalog extends WorkspaceDirectory {
  toDirectoryOption(record: Workspace): MuximodWorkspaceDirectory;
  browseDirectories(parentPath?: string): ApplicationEffect<MuximodWorkspaceDirectory[]>;
  resolveWorkspaceDirectory(
    workspaceId: WorkspaceId,
    findWorkspace: (id: WorkspaceId) => ApplicationEffect<Workspace | undefined>,
  ): ApplicationEffect<Workspace>;
  resolveSelection(
    selection: WorkspaceSelection,
    findWorkspace: (id: WorkspaceId) => ApplicationEffect<Workspace | undefined>,
  ): ApplicationEffect<Workspace>;
}

/** Application-owned workspace persistence capability. */
export class WorkspaceRepositoryService extends Context.Service<WorkspaceRepositoryService, WorkspaceRepository>()(
  "@muximo/application/WorkspaceRepository",
) {}

/** Application-owned host directory and hook resolution capability. */
export class WorkspaceDirectoryService extends Context.Service<WorkspaceDirectoryService, WorkspaceDirectory>()(
  "@muximo/application/WorkspaceDirectory",
) {}

/** Application-owned workspace audit capability. */
export class WorkspaceAuditService extends Context.Service<WorkspaceAuditService, WorkspaceAudit>()(
  "@muximo/application/WorkspaceAudit",
) {}

/** Application-owned database-only atomic scope capability. */
export class TransactionManagerService extends Context.Service<TransactionManagerService, TransactionManager>()(
  "@muximo/application/TransactionManager",
) {}

/** Application-owned workspace catalog capability (selection and browsing). */
export class MuximodWorkspaceCatalogService extends Context.Service<
  MuximodWorkspaceCatalogService,
  MuximodWorkspaceCatalog
>()("@muximo/application/MuximodWorkspaceCatalog") {}

/** Services required by the workspace usecases. */
export type WorkspaceServices =
  | WorkspaceRepositoryService
  | WorkspaceDirectoryService
  | WorkspaceAuditService
  | TransactionManagerService
  | MuximodWorkspaceCatalogService;

/** Provides the workspace repository implementation from the composition root. */
export const workspaceRepositoryLayer = (repository: WorkspaceRepository): Layer.Layer<WorkspaceRepositoryService> =>
  Layer.succeed(WorkspaceRepositoryService, repository);

/** Provides the workspace directory implementation from the composition root. */
export const workspaceDirectoryLayer = (directories: WorkspaceDirectory): Layer.Layer<WorkspaceDirectoryService> =>
  Layer.succeed(WorkspaceDirectoryService, directories);

/** Provides the workspace audit implementation from the composition root. */
export const workspaceAuditLayer = (audit: WorkspaceAudit): Layer.Layer<WorkspaceAuditService> =>
  Layer.succeed(WorkspaceAuditService, audit);

/** Audit implementation used when no audit sink is configured. */
export const noopWorkspaceAuditLayer = (): Layer.Layer<WorkspaceAuditService> =>
  workspaceAuditLayer({ record: () => Effect.succeed(undefined) });

/** Provides the transaction manager implementation from the composition root. */
export const transactionManagerLayer = (transactions: TransactionManager): Layer.Layer<TransactionManagerService> =>
  Layer.succeed(TransactionManagerService, transactions);

/** Scope implementation used when no transaction manager is configured. */
export const passthroughTransactionManagerLayer = (): Layer.Layer<TransactionManagerService> =>
  transactionManagerLayer({ run: (operation) => operation });

/** Provides the workspace catalog implementation from the composition root. */
export const workspaceCatalogLayer = (catalog: MuximodWorkspaceCatalog): Layer.Layer<MuximodWorkspaceCatalogService> =>
  Layer.succeed(MuximodWorkspaceCatalogService, catalog);

/** Assembles the workspace service layer from concrete implementations. */
export const workspaceLayer = (dependencies: {
  repository: WorkspaceRepository;
  directories: WorkspaceDirectory;
  audit?: WorkspaceAudit;
  transactions?: TransactionManager;
  catalog?: MuximodWorkspaceCatalog;
}): Layer.Layer<WorkspaceServices> =>
  Layer.mergeAll(
    workspaceRepositoryLayer(dependencies.repository),
    workspaceDirectoryLayer(dependencies.directories),
    dependencies.audit ? workspaceAuditLayer(dependencies.audit) : noopWorkspaceAuditLayer(),
    dependencies.transactions
      ? transactionManagerLayer(dependencies.transactions)
      : passthroughTransactionManagerLayer(),
    ...(dependencies.catalog ? [workspaceCatalogLayer(dependencies.catalog)] : []),
  );
