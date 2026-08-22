import type { PaneId } from "@muximo/domain";
import type { PaneGateway } from "../../ports/panes.js";
import type { PaneRepository } from "../../ports/repositories.js";

export class SendPaneInput {
  public constructor(
    private readonly panes: PaneRepository,
    private readonly gateway: PaneGateway,
  ) {}

  public async execute(paneId: PaneId, input: string): Promise<void> {
    const pane = await this.panes.findById(paneId);
    if (!pane) throw new Error(`Pane not found: ${paneId}`);
    await this.gateway.sendInput(paneId, input);
  }
}
