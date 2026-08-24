import type { WorkspaceRecord } from "@muximo/domain";
import { WorkspaceUpdateEmptyError } from "@muximo/domain";
import type { WorkspaceRepository } from "../../ports/repositories.js";
import type { TransactionManager } from "../../ports/transactions.js";
import type { WorkspaceAuditPort, WorkspaceDirectoryPort } from "../../ports/workspace.js";
import { findWorkspace } from "./find-workspace.js";
import { runInTransaction } from "./register-workspace.js";
import type { UpdateWorkspaceInput } from "./workspace-inputs.js";
import type { WorkspaceRecordFactory } from "./workspace-record-factory.js";

export class UpdateWorkspace {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly directories: WorkspaceDirectoryPort,
    private readonly factory: WorkspaceRecordFactory,
    private readonly audit?: WorkspaceAuditPort,
    private readonly transactionManager?: TransactionManager,
  ) {}

  public async execute(selector: string, input: UpdateWorkspaceInput): Promise<WorkspaceRecord> {
    if (!hasWorkspaceUpdate(input)) throw new WorkspaceUpdateEmptyError();
    const existing = await findWorkspace(this.workspaces, this.directories, selector);
    const workspace = await this.factory.update(existing, input);
    return runInTransaction(this.transactionManager, async () => {
      await this.workspaces.upsert(workspace);
      await this.audit?.record("workspace.updated", workspace.id, {
        name: workspace.name,
        directory: workspace.rootPath,
      });
      return workspace;
    });
  }
}

function hasWorkspaceUpdate(input: UpdateWorkspaceInput): boolean {
  return (
    input.name !== undefined ||
    input.setupHook !== undefined ||
    input.cleanupHook !== undefined ||
    input.worktreeCopyPatterns !== undefined ||
    (input.appendCopyPatterns?.length ?? 0) > 0 ||
    input.clearCopyPatterns === true
  );
}
