import { useEffect, useRef, useState } from "react";
import type { PaneSummary } from "@muximo/contract";
import type { WaitingAgent } from "./-waiting-notification-patterns";

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
      previousWaitingIdsRef.current = new Set(
        panes
          .filter((pane) => pane.state === "waiting_input" || pane.state === "waiting_approval")
          .map((pane) => pane.id),
      );
      return;
    }

    const previous = previousWaitingIdsRef.current;
    const lateAdditions: PaneSummary[] = [];
    const stillWaiting = new Set<string>();
    for (const pane of panes) {
      const isWaiting = pane.state === "waiting_input" || pane.state === "waiting_approval";
      if (!isWaiting) continue;
      stillWaiting.add(pane.id);
      if (!previous.has(pane.id)) lateAdditions.push(pane);
    }
    previousWaitingIdsRef.current = new Set(panes
      .filter((pane) => pane.state === "waiting_input" || pane.state === "waiting_approval")
      .map((pane) => pane.id));

    if (!lateAdditions.length) return;
    const incoming = lateAdditions
      .map(prepareNotice)
      .filter((notice): notice is WaitingNotice => notice !== null);
    if (!incoming.length) return;
    setNotices((current) => {
      const withoutResolved = current.filter((notice) => stillWaiting.has(notice.id));
      const merged = [...withoutResolved, ...incoming];
      const unique = merged.filter((notice, index) => merged.findIndex((candidate) => candidate.id === notice.id) === index);
      return unique.slice(-MAX_NOTICES);
    });
  }, [panes]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!notices.length) return;
    const timer = window.setTimeout(() => {
      setNotices([]);
    }, NOTICE_CLEANUP_MS);
    return () => window.clearTimeout(timer);
  }, [notices.length]);

  const open = (id: string) => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  };

  return { notices, open };
}

function prepareNotice(pane: PaneSummary): WaitingNotice | null {
  const state: WaitingNoticeState | null = pane.state === "waiting_input"
    ? "waiting_input"
    : pane.state === "waiting_approval"
      ? "waiting_approval"
      : null;
  if (!state) return null;
  return {
    id: pane.id,
    target: pane.tmuxPaneId,
    name: pane.name,
    kind: pane.kind === "agent" ? "agent" : "shell",
    agentId: pane.agentId,
    state,
    cwd: pane.cwd,
    recentOutput: pane.recentOutput ?? "",
  };
}

export function toToastAgent(notice: WaitingNotice): WaitingAgent {
  const agentBadgeClass = notice.agentId === "claude"
    ? "border-[#9a5b3c] bg-[rgb(154_52_18_/_22%)] text-[#fdba74]"
    : notice.agentId === "opencode"
      ? "border-[#3d8b4c] bg-[rgb(57_214_91_/_14%)] text-lime"
      : "border-[#2b6f8a] bg-[rgb(21_94_117_/_24%)] text-[#7dd3fc]";
  return {
    id: notice.id,
    name: notice.name,
    monogram: notice.kind === "shell" ? "S" : (notice.agentId?.slice(0, 1) ?? "·").toUpperCase(),
    badgeClass: notice.kind === "shell"
      ? "border-[#6a7a72] bg-[rgb(90_105_98_/_22%)] text-[#b7c4bd]"
      : agentBadgeClass,
    state: notice.state,
    stateLabel: notice.state === "waiting_input" ? "Waiting for input" : "Waiting for approval",
    cwd: notice.cwd,
    recentOutput: notice.recentOutput,
    target: notice.target,
    time: "just now",
  };
}
