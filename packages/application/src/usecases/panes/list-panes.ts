import type { PaneRecord } from "@muximo/domain";
import type { PaneFilter, PaneRepository } from "../../ports/repositories.js";

export class ListPanes {
  public constructor(private readonly panes: PaneRepository) {}

  public execute(filter?: PaneFilter): Promise<PaneRecord[]> {
    return this.panes.list(filter);
  }
}
