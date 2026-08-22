import type { PaneRecord } from "@muximo/domain";
import type { MuximodSessionSummary } from "../../ports/application.js";

/** Derives the session summaries shown to clients from reconciled panes. */
export function summarizeSessions(panes: PaneRecord[]): MuximodSessionSummary[] {
  const groups = new Map<string, PaneRecord[]>();
  for (const pane of panes) groups.set(pane.sessionName, [...(groups.get(pane.sessionName) ?? []), pane]);

  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, sessionPanes]) => {
      const agents = sessionPanes.filter((pane) => pane.kind === "agent").length;
      const shells = sessionPanes.filter((pane) => pane.kind === "shell").length;
      const waitingCount = sessionPanes.filter(
        (pane) => pane.state === "waiting_input" || pane.state === "waiting_approval",
      ).length;
      const detailParts = [`${agents} agent${agents === 1 ? "" : "s"}`, `${shells} shell${shells === 1 ? "" : "s"}`];
      if (waitingCount) detailParts.push(`${waitingCount} waiting`);
      return {
        name,
        paneCount: sessionPanes.length,
        waitingCount,
        detail: detailParts.join(" · "),
      } satisfies MuximodSessionSummary;
    });
}
