import { Effect } from "effect";
import { WorkspaceAlreadyRegisteredError } from "./workspace-errors.js";
import type { RegisterWorkspaceInput } from "./workspace-inputs.js";
import { createWorkspaceRecord } from "./workspace-record-factory.js";
import { TransactionManagerService, WorkspaceAuditService, WorkspaceRepositoryService } from "./workspace-services.js";

export const registerWorkspace = Effect.fn("Workspaces.register")(function* (input: RegisterWorkspaceInput) {
  const candidate = yield* createWorkspaceRecord(input);
  const workspaces = yield* WorkspaceRepositoryService;
  const audit = yield* WorkspaceAuditService;
  const transactions = yield* TransactionManagerService;
  return yield* transactions.run(
    Effect.gen(function* () {
      if (!(yield* workspaces.insert(candidate))) {
        return yield* Effect.fail(
          new WorkspaceAlreadyRegisteredError({
            id: candidate.id,
            rootPath: candidate.rootPath,
            name: candidate.name,
            isGit: candidate.isGit,
          }),
        );
      }
      yield* audit.record("workspace.created", candidate.id, {
        name: candidate.name,
        directory: candidate.rootPath,
      });
      return candidate;
    }),
  );
});
