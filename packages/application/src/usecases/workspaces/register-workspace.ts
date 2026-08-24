import type { WorkspaceRecord } from "@muximo/domain";
import type { WorkspaceRepository } from "../../ports/repositories.js";
import type { TransactionManager } from "../../ports/transactions.js";
import type { WorkspaceAuditPort } from "../../ports/workspace.js";
import { WorkspaceAlreadyRegisteredError } from "./workspace-errors.js";
import type { RegisterWorkspaceInput } from "./workspace-inputs.js";
import type { WorkspaceRecordFactory } from "./workspace-record-factory.js";

export class RegisterWorkspace {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly factory: WorkspaceRecordFactory,
    private readonly audit?: WorkspaceAuditPort,
    private readonly transactionManager?: TransactionManager,
  ) {}

  public async execute(input: RegisterWorkspaceInput): Promise<WorkspaceRecord> {
    const candidate = await this.factory.create(input);
    return runInTransaction(this.transactionManager, async () => {
      if (!(await this.workspaces.insert(candidate))) {
        throw new WorkspaceAlreadyRegisteredError({
          id: candidate.id,
          rootPath: candidate.rootPath,
          name: candidate.name,
          isGit: candidate.isGit,
        });
      }
      await this.audit?.record("workspace.created", candidate.id, {
        name: candidate.name,
        directory: candidate.rootPath,
      });
      return candidate;
    });
  }
}

/** Runs the operation inside a transaction when a manager is configured. */
export function runInTransaction<Result>(
  transactionManager: TransactionManager | undefined,
  operation: () => Promise<Result>,
): Promise<Result> {
  return transactionManager ? transactionManager.run(operation) : operation();
}
