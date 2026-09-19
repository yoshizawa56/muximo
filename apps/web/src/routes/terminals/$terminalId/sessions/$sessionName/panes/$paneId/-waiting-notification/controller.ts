import type { PaneSummary } from "@muximo/contract/api";
import { useEffect, useRef, useState } from "react";
import type { WaitingAgent } from "./patterns";

export type WaitingNoticeState = "waiting_input" | "waiting_approval";

export type WaitingNotice = {
  id: string;
  target: string;
  name: string;
  kind: "shell" | "agent";
  agentId: string | null;
  state: WaitingNoticeState;
  cwd: string;
  recentOutput: string;
};

const NOTICE_DURATION_MS = 5_000;
const NOTICE_CLEANUP_MS = NOTICE_DURATION_MS + 400;
const MAX_NOTICES = 3;

export type WaitingNoticeReconciliation = {
  notices: WaitingNotice[];
  waitingIds: Set<string>;
};

/** Reconciles transient notices with the latest pane projection. */
export function reconcileWaitingNotices(
  current: readonly WaitingNotice[],
  panes: readonly PaneSummary[],
  previousWaitingIds: ReadonlySet<string>,
): WaitingNoticeReconciliation {
  const waitingPanes = panes.filter(isWaitingPane);
  const waitingIds = new Set(waitingPanes.map((pane) => pane.id));
  const incoming = waitingPanes
    .filter((pane) => !previousWaitingIds.has(pane.id))
    .map(prepareNotice)
    .filter((notice): notice is WaitingNotice => notice !== null);
  const withoutResolved = current.filter((notice) => waitingIds.has(notice.id));
  if (incoming.length === 0 && withoutResolved.length === current.length) {
    return { notices: current as WaitingNotice[], waitingIds };
  }
  const byId = new Map(withoutResolved.map((notice) => [notice.id, notice]));
  for (const notice of incoming) byId.set(notice.id, notice);
  return { notices: [...byId.values()].slice(-MAX_NOTICES), waitingIds };
}

/** Returns the identity used by the cleanup effect for the current notice set. */
export function waitingNoticeTimerKey(notices: readonly WaitingNotice[]): string {
  return notices
    .map((notice) =>
      [
        notice.id,
        notice.target,
        notice.name,
        notice.kind,
        notice.agentId ?? "",
        notice.state,
        notice.cwd,
        notice.recentOutput,
      ].join("\u0000"),
    )
    .join("\u0001");
}

export function useWaitingNotices(panes: PaneSummary[]): { notices: WaitingNotice[]; open: (id: string) => void } {
  const [notices, setNotices] = useState<WaitingNotice[]>([]);
  const previousWaitingIdsRef = useRef<Set<string>>(new Set());
  const primedRef = useRef(false);

  useEffect(() => {
    if (!primedRef.current) {
      // Wait for the first real data payload so already-waiting panes do not
      // trigger a burst of notifications on load. Only state transitions that
      // happen afterwards are announced.
      if (panes.length === 0) return;
      primedRef.current = true;
      previousWaitingIdsRef.current = waitingIdsForPanes(panes);
      return;
    }

    const previous = previousWaitingIdsRef.current;
    const nextWaitingIds = waitingIdsForPanes(panes);
    previousWaitingIdsRef.current = nextWaitingIds;
    setNotices((current) => {
      return reconcileWaitingNotices(current, panes, previous).notices;
    });
  }, [panes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!notices.length) return;
    const timer = window.setTimeout(() => {
      setNotices([]);
    }, NOTICE_CLEANUP_MS);
    return () => window.clearTimeout(timer);
  }, [notices]);

  const open = (id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  };

  return { notices, open };
}

function prepareNotice(pane: PaneSummary): WaitingNotice | null {
  const state: WaitingNoticeState | null =
    pane.state === "waiting_input" ? "waiting_input" : pane.state === "waiting_approval" ? "waiting_approval" : null;
  if (!state) return null;
  return {
    id: pane.id,
    target: pane.hostPaneId,
    name: pane.name,
    kind: pane.kind === "agent" ? "agent" : "shell",
    agentId: pane.agentId,
    state,
    cwd: pane.cwd,
    recentOutput: pane.recentOutput ?? "",
  };
}

function isWaitingPane(pane: PaneSummary): boolean {
  return pane.state === "waiting_input" || pane.state === "waiting_approval";
}

function waitingIdsForPanes(panes: readonly PaneSummary[]): Set<string> {
  return new Set(panes.filter(isWaitingPane).map((pane) => pane.id));
}

export function toToastAgent(notice: WaitingNotice): WaitingAgent {
  const agentBadgeClass =
    notice.agentId === "claude"
      ? "border-[#9a5b3c] bg-[rgb(154_52_18_/_22%)] text-[#fdba74]"
      : notice.agentId === "opencode"
        ? "border-[#3d8b4c] bg-[rgb(57_214_91_/_14%)] text-lime"
        : "border-[#2b6f8a] bg-[rgb(21_94_117_/_24%)] text-[#7dd3fc]";
  return {
    id: notice.id,
    name: notice.name,
    monogram: notice.kind === "shell" ? "S" : (notice.agentId?.slice(0, 1) ?? "·").toUpperCase(),
    badgeClass: notice.kind === "shell" ? "border-[#6a7a72] bg-[rgb(90_105_98_/_22%)] text-[#b7c4bd]" : agentBadgeClass,
    state: notice.state,
    stateLabel: notice.state === "waiting_input" ? "Waiting for input" : "Waiting for approval",
    cwd: notice.cwd,
    recentOutput: notice.recentOutput,
    target: notice.target,
    time: "just now",
  };
}
