import type { PaneRecord } from "@muximo/domain";
import type { PaneFilter } from "../../models/panes.js";
import type { PaneRepository } from "../../ports/repositories.js";

export class ListPanes {
  public constructor(private readonly panes: PaneRepository) {}

  public execute(filter?: PaneFilter): Promise<PaneRecord[]> {
    return this.panes.list(filter);
  }
}
