import type { PaneId } from "@muximo/domain";
import type { PaneGateway } from "../../ports/panes.js";
import type { PaneRepository } from "../../ports/repositories.js";

export class ResizePane {
  public constructor(private readonly panes: PaneRepository, private readonly gateway: PaneGateway) {}

  public async execute(paneId: PaneId, cols: number, rows: number): Promise<void> {
    if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
      throw new Error("Terminal dimensions must be positive integers");
    }
    const pane = await this.panes.findById(paneId);
    if (!pane) throw new Error(`Pane not found: ${paneId}`);
    await this.gateway.resize(paneId, cols, rows);
  }
}
