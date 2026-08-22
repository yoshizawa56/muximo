import type { WorkspaceRecord } from "@muximo/domain";
import type { WorkspaceRepository } from "../../ports/repositories.js";
import type { TransactionManager } from "../../ports/transactions.js";
import type { WorkspaceAuditPort, WorkspaceDirectoryPort } from "../../ports/workspace.js";
import { findWorkspace } from "./find-workspace.js";
import { runInTransaction } from "./register-workspace.js";

export class DeleteWorkspace {
  public constructor(
    private readonly workspaces: WorkspaceRepository,
    private readonly directories: WorkspaceDirectoryPort,
    private readonly audit?: WorkspaceAuditPort,
    private readonly transactionManager?: TransactionManager,
  ) {}

  public async execute(selector: string): Promise<WorkspaceRecord> {
    const workspace = await findWorkspace(this.workspaces, this.directories, selector);
    return runInTransaction(this.transactionManager, async () => {
      await this.workspaces.delete(workspace.id);
      await this.audit?.record("workspace.deleted", workspace.id, {
        name: workspace.name,
        directory: workspace.rootPath,
      });
      return workspace;
    });
  }
}
