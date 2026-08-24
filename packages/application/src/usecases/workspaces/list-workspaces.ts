import type { WorkspaceRecord } from "@muximo/domain";
import type { WorkspaceRepository } from "../../ports/repositories.js";

export class ListWorkspaces {
  public constructor(private readonly workspaces: WorkspaceRepository) {}

  public execute(): Promise<WorkspaceRecord[]> {
    return this.workspaces.list();
  }
}
