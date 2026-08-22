import type { PaneRecord, PaneState } from "@muximo/domain";

export type PaneFilter = {
  state?: PaneState;
  kind?: PaneRecord["kind"];
  sessionName?: string;
};
