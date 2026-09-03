import { Context, Effect, Layer } from "effect";
import type { MuximodWorkspaceCatalogPort } from "../../ports/host.js";
import type { WorkspaceRepository } from "../../ports/repositories.js";
import type { TransactionManager } from "../../ports/transactions.js";
import type { WorkspaceAuditPort, WorkspaceDirectoryPort } from "../../ports/workspace.js";

/** Application-owned workspace persistence capability. */
export class WorkspaceRepositoryService extends Context.Service<WorkspaceRepositoryService, WorkspaceRepository>()(
  "@muximo/application/WorkspaceRepository",
) {}

/** Application-owned host directory and hook resolution capability. */
export class WorkspaceDirectoryService extends Context.Service<WorkspaceDirectoryService, WorkspaceDirectoryPort>()(
  "@muximo/application/WorkspaceDirectory",
) {}

/** Application-owned workspace audit capability. */
export class WorkspaceAuditService extends Context.Service<WorkspaceAuditService, WorkspaceAuditPort>()(
  "@muximo/application/WorkspaceAudit",
) {}

/** Application-owned database-only atomic scope capability. */
export class TransactionManagerService extends Context.Service<TransactionManagerService, TransactionManager>()(
  "@muximo/application/TransactionManager",
) {}

/** Application-owned workspace catalog capability (selection and browsing). */
export class MuximodWorkspaceCatalogService extends Context.Service<
  MuximodWorkspaceCatalogService,
  MuximodWorkspaceCatalogPort
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
export const workspaceDirectoryLayer = (directories: WorkspaceDirectoryPort): Layer.Layer<WorkspaceDirectoryService> =>
  Layer.succeed(WorkspaceDirectoryService, directories);

/** Provides the workspace audit implementation from the composition root. */
export const workspaceAuditLayer = (audit: WorkspaceAuditPort): Layer.Layer<WorkspaceAuditService> =>
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
export const workspaceCatalogLayer = (
  catalog: MuximodWorkspaceCatalogPort,
): Layer.Layer<MuximodWorkspaceCatalogService> => Layer.succeed(MuximodWorkspaceCatalogService, catalog);

/** Assembles the workspace service layer from concrete implementations. */
export const workspaceLayer = (dependencies: {
  repository: WorkspaceRepository;
  directories: WorkspaceDirectoryPort;
  audit?: WorkspaceAuditPort;
  transactions?: TransactionManager;
  catalog?: MuximodWorkspaceCatalogPort;
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
