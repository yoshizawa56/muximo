import { WorkspaceUpdateEmptyError } from "@muximo/domain";
import { Effect } from "effect";
import { findWorkspace } from "./find-workspace.js";
import type { UpdateWorkspaceInput } from "./workspace-inputs.js";
import { updateWorkspaceRecord } from "./workspace-record-factory.js";
import { TransactionManagerService, WorkspaceAuditService, WorkspaceRepositoryService } from "./workspace-services.js";

export const updateWorkspace = Effect.fn("Workspaces.update")(function* (
  selector: string,
  input: UpdateWorkspaceInput,
) {
  if (!hasWorkspaceUpdate(input)) return yield* Effect.fail(new WorkspaceUpdateEmptyError());
  const existing = yield* findWorkspace(selector);
  const workspace = yield* updateWorkspaceRecord(existing, input);
  const workspaces = yield* WorkspaceRepositoryService;
  const audit = yield* WorkspaceAuditService;
  const transactions = yield* TransactionManagerService;
  return yield* transactions.run(
    Effect.gen(function* () {
      yield* workspaces.upsert(workspace);
      yield* audit.record("workspace.updated", workspace.id, {
        name: workspace.name,
        directory: workspace.rootPath,
      });
      return workspace;
    }),
  );
});

function hasWorkspaceUpdate(input: UpdateWorkspaceInput): boolean {
  return input.name !== undefined || input.setupHook !== undefined || input.cleanupHook !== undefined;
}
