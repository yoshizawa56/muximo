import type { PaneId } from "@muximo/domain";

export interface PaneGateway {
  sendInput(paneId: PaneId, input: string): Promise<void>;
  resize(paneId: PaneId, cols: number, rows: number): Promise<void>;
  close(paneId: PaneId): Promise<void>;
}
