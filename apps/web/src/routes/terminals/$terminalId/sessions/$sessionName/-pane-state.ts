import type { PaneSummary } from "@muximo/contract/api";

export function paneStateLabel(state: PaneSummary["state"]): string {
  switch (state) {
    case "waiting_input":
      return "Waiting for input";
    case "waiting_approval":
      return "Waiting for approval";
    case "failed":
      return "Failed";
    case "completed":
      return "Completed";
    case "stopped":
      return "Stopped";
    case "starting":
      return "Starting";
    default:
      return "Running";
  }
}
