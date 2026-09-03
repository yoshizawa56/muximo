import { Effect } from "effect";
import { findWorkspace } from "./find-workspace.js";
import { TransactionManagerService, WorkspaceAuditService, WorkspaceRepositoryService } from "./workspace-services.js";

export const deleteWorkspace = Effect.fn("Workspaces.delete")(function* (selector: string) {
  const workspace = yield* findWorkspace(selector);
  const workspaces = yield* WorkspaceRepositoryService;
  const audit = yield* WorkspaceAuditService;
  const transactions = yield* TransactionManagerService;
  return yield* transactions.run(
    Effect.gen(function* () {
      yield* workspaces.delete(workspace.id);
      yield* audit.record("workspace.deleted", workspace.id, {
        name: workspace.name,
        directory: workspace.rootPath,
      });
      return workspace;
    }),
  );
});
