import { type CSSProperties, useEffect, useRef, useState } from "react";

export type WaitingNotificationState = "waiting_input" | "waiting_approval";

export type WaitingAgent = {
  id: string;
  name: string;
  monogram: string;
  badgeClass: string;
  state: WaitingNotificationState;
  stateLabel: string;
  cwd: string;
  recentOutput: string;
  target: string;
  time: string;
};

export const waitingAgents: WaitingAgent[] = [
  {
    id: "pane-review",
    name: "Review the viewport lease",
    monogram: "C",
    badgeClass: "border-[#2b6f8a] bg-[rgb(21_94_117_/_24%)] text-[#7dd3fc]",
    state: "waiting_input",
    stateLabel: "Waiting for input",
    cwd: "~/work/muximo",
    recentOutput: "Continue with the next task?",
    target: "%0",
    time: "just now",
  },
  {
    id: "pane-approval",
    name: "Check the migration plan",
    monogram: "C",
    badgeClass: "border-[#9a5b3c] bg-[rgb(154_52_18_/_22%)] text-[#fdba74]",
    state: "waiting_approval",
    stateLabel: "Waiting for approval",
    cwd: "~/work/papercal",
    recentOutput: "Apply this migration?",
    target: "%3",
    time: "1m ago",
  },
];

export function NotificationKeyframes() {
  return (
    <style>{`
      @keyframes notice-toast-in {
        from { opacity: 0; transform: translateY(-18px) scale(0.96); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes notice-toast-out {
        from { opacity: 1; transform: translateY(0) scale(1); }
        to { opacity: 0; transform: translateY(-10px) scale(0.97); }
      }
      @keyframes notice-toast-timer-v {
        from { transform: scaleY(1); }
        to { transform: scaleY(0); }
      }
      @keyframes notice-dock-in {
        from { opacity: 0; transform: translateY(16px) scale(0.98); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes notice-banner-in {
        from { opacity: 0; transform: translateY(-100%); }
        to { opacity: 1; transform: translateY(0); }
      }
      .notice-a { animation: notice-toast-in 380ms cubic-bezier(0.21, 1.02, 0.45, 1) both; }
      .notice-a-out { animation: notice-toast-out 260ms ease-in both; }
      .notice-a-timer-v { animation: notice-toast-timer-v 5s linear both; transform-origin: bottom; }
      .notice-b { animation: notice-dock-in 360ms cubic-bezier(0.21, 1.02, 0.45, 1) both; }
      .notice-c { animation: notice-banner-in 320ms cubic-bezier(0.21, 1.02, 0.45, 1) both; }
      @media (prefers-reduced-motion: reduce) {
        .notice-a, .notice-a-out, .notice-a-timer-v, .notice-b, .notice-c { animation: none !important; }
      }
    `}</style>
  );
}

const TOAST_STAGGER_MS = 140;
const DISMISS_DRAG_THRESHOLD = 64;
const TAP_MAX_DRAG = 8;

export function ToastPattern({
  agents,
  durationMs = 5_000,
  onOpen,
}: {
  agents: WaitingAgent[];
  durationMs?: number;
  onOpen?: (agent: WaitingAgent) => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-2.5 z-30 flex flex-col items-center gap-2 px-3">
      {agents.map((agent, index) => (
        <ToastCard key={agent.id} agent={agent} index={index} durationMs={durationMs} onOpen={onOpen} />
      ))}
    </div>
  );
}

function ToastCard({
  agent,
  index,
  durationMs,
  onOpen,
}: {
  agent: WaitingAgent;
  index: number;
  durationMs: number;
  onOpen?: (agent: WaitingAgent) => void;
}) {
  const [open, setOpen] = useState(true);
  const [removed, setRemoved] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.ceil(durationMs / 1_000));
  const [entered, setEntered] = useState(false);
  const [dragX, setDragX] = useState(0);
  const [swipedOut, setSwipedOut] = useState(false);
  const dragStartXRef = useRef(0);
  const draggingRef = useRef(false);
  const draggedRef = useRef(false);
  const delayMs = index * TOAST_STAGGER_MS;
  const lifeMs = durationMs + delayMs;

  useEffect(() => {
    const closeTimer = window.setTimeout(() => setOpen(false), lifeMs);
    return () => window.clearTimeout(closeTimer);
  }, [lifeMs]);

  useEffect(() => {
    const tickTimer = window.setInterval(() => {
      setSecondsLeft((current) => Math.max(0, current - 1));
    }, 1_000);
    return () => window.clearInterval(tickTimer);
  }, []);

  useEffect(() => {
    if (open) return;
    const removeTimer = window.setTimeout(() => setRemoved(true), 320);
    return () => window.clearTimeout(removeTimer);
  }, [open]);

  useEffect(() => {
    if (!swipedOut) return;
    const removeTimer = window.setTimeout(() => setRemoved(true), 300);
    return () => window.clearTimeout(removeTimer);
  }, [swipedOut]);

  if (removed) return null;

  const cardStyle: CSSProperties = {
    animationDelay: open && !entered ? `${delayMs}ms` : undefined,
  };
  if (swipedOut) {
    cardStyle.transform = "translateX(115%)";
    cardStyle.opacity = 0;
    cardStyle.transition = "transform 280ms ease-in, opacity 240ms ease-in";
  } else {
    cardStyle.transition = draggingRef.current ? "none" : "transform 180ms ease-out";
    if (dragX !== 0) cardStyle.transform = `translateX(${dragX}px)`;
  }

  return (
    <button
      type="button"
      className={`pointer-events-auto relative w-full max-w-[330px] touch-pan-y cursor-pointer overflow-hidden rounded-[13px] border border-[#5a4a24] bg-[rgb(24_19_8_/_94%)] text-left shadow-[0_16px_44px_rgb(0_0_0_/_50%),inset_0_0_0_1px_rgb(241_199_109_/_10%)] backdrop-blur-[14px] ${entered ? "" : "notice-a"} ${open ? "" : "notice-a-out"}`}
      style={cardStyle}
      aria-label={`Open ${agent.name}`}
      onAnimationEnd={(event) => {
        if (event.animationName === "notice-toast-in") setEntered(true);
      }}
      onPointerDown={(event) => {
        draggedRef.current = false;
        dragStartXRef.current = event.clientX;
        draggingRef.current = true;
        setDragX(0);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!draggingRef.current) return;
        const dx = Math.max(0, event.clientX - dragStartXRef.current);
        if (dx > TAP_MAX_DRAG) draggedRef.current = true;
        setDragX(dx);
      }}
      onPointerUp={(event) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        const finalDx = Math.max(0, event.clientX - dragStartXRef.current);
        if (finalDx >= DISMISS_DRAG_THRESHOLD) setSwipedOut(true);
        else setDragX(0);
      }}
      onPointerCancel={() => {
        draggingRef.current = false;
        setDragX(0);
      }}
      onClick={() => {
        if (!draggedRef.current && !swipedOut) onOpen?.(agent);
      }}
    >
      <span
        className="notice-a-timer-v absolute inset-y-0 left-0 w-[3px] bg-amber shadow-[0_0_12px_rgb(241_199_109_/_60%)]"
        style={{ animationDelay: `${delayMs}ms`, animationDuration: `${durationMs}ms` }}
      />
      <span className="flex items-center gap-2.5 py-2.5 pl-[15px] pr-2">
        <span
          className={`grid size-8 shrink-0 place-items-center rounded-lg border font-mono text-[0.72rem] font-extrabold ${agent.badgeClass}`}
        >
          {agent.monogram}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="flex min-w-0 items-center gap-1.5">
            <strong className="min-w-0 overflow-hidden text-[0.7rem] font-bold text-ellipsis whitespace-nowrap text-[#f3e7c3]">
              {agent.name}
            </strong>
            <span className="shrink-0 rounded-[4px] bg-amber px-[5px] py-[2px] font-mono text-[0.48rem] font-bold leading-none text-[#1a1506]">
              {agent.state === "waiting_input" ? "INPUT" : "APPROVAL"}
            </span>
          </span>
          <small className="overflow-hidden font-mono text-[0.54rem] text-ellipsis whitespace-nowrap text-[#d9b36b]">
            {agent.recentOutput}
          </small>
        </span>
        <span className="shrink-0 font-mono text-[0.48rem] font-bold text-amber/90">{secondsLeft}s</span>
      </span>
    </button>
  );
}

export function DockPattern({ agents }: { agents: WaitingAgent[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-2.5 z-30 flex flex-col items-center px-3">
      {expanded ? (
        <div className="notice-b pointer-events-auto w-full max-w-[330px] overflow-hidden rounded-[15px] border border-[#4c3d1c] bg-[rgb(20_17_8_/_95%)] shadow-[0_18px_54px_rgb(0_0_0_/_52%),inset_0_0_0_1px_rgb(241_199_109_/_8%)] backdrop-blur-[14px]">
          <header className="flex items-center justify-between gap-2 border-b border-[#3a2f15] px-3 py-2">
            <span className="flex items-center gap-1.5 font-mono text-[0.55rem] font-bold tracking-[0.12em] text-[#d9b36b]">
              <span className="size-1.5 rounded-full bg-amber shadow-[0_0_0_3px_rgb(241_199_109_/_16%)]" />
              WAITING · {agents.length}
            </span>
            <button
              className="grid size-6 place-items-center rounded-md text-[0.62rem] text-[#8a7442] transition-colors hover:text-amber"
              type="button"
              onClick={() => setExpanded(false)}
              aria-label="Collapse"
            >
              ▾
            </button>
          </header>
          <div className="flex flex-col">
            {agents.map((agent) => (
              <div
                key={agent.id}
                className="flex items-center gap-2.5 border-b border-[#2c2410] px-3 py-2.5 last:border-0"
              >
                <span
                  className={`grid size-7 shrink-0 place-items-center rounded-lg border font-mono text-[0.64rem] font-extrabold ${agent.badgeClass}`}
                >
                  {agent.monogram}
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
                  <strong className="min-w-0 overflow-hidden text-[0.66rem] font-bold text-ellipsis whitespace-nowrap text-[#f3e7c3]">
                    {agent.name}
                  </strong>
                  <small className="overflow-hidden font-mono text-[0.52rem] text-ellipsis whitespace-nowrap text-[#d9b36b]">
                    {agent.stateLabel} · {agent.time}
                  </small>
                </div>
                <button
                  className="shrink-0 rounded-md border border-[#5a4a24] bg-[rgb(38_30_12_/_70%)] px-2 py-[5px] font-mono text-[0.56rem] font-bold text-[#f1d9a0] transition-colors hover:border-amber hover:text-amber"
                  type="button"
                  aria-label={`Open ${agent.name}`}
                >
                  open →
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <button
          className="notice-b pointer-events-auto flex items-center gap-2 rounded-full border border-[#4c3d1c] bg-[rgb(20_17_8_/_95%)] py-[7px] pl-[9px] pr-3.5 shadow-[0_16px_44px_rgb(0_0_0_/_50%)] backdrop-blur-[14px]"
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          aria-label={`${agents.length} agents waiting`}
        >
          <span className="flex items-center -space-x-[6px]">
            {agents.slice(0, 3).map((agent) => (
              <span
                key={agent.id}
                className={`grid size-[22px] place-items-center rounded-full border-2 border-[rgb(20_17_8_/_95%)] font-mono text-[0.5rem] font-extrabold ${agent.badgeClass}`}
              >
                {agent.monogram}
              </span>
            ))}
          </span>
          <span className="ml-1 font-mono text-[0.62rem] font-bold text-[#f3e7c3]">{agents.length} waiting</span>
          <span className="font-mono text-[0.58rem] text-[#8a7442]">▴</span>
        </button>
      )}
    </div>
  );
}

export function BannerPattern({ agents }: { agents: WaitingAgent[] }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-30 overflow-hidden">
      {agents.map((agent, index) => (
        <div
          key={agent.id}
          className="notice-c pointer-events-auto relative flex items-center gap-2.5 border-b border-[#3d3115] bg-[rgb(22_17_6_/_96%)] py-[9px] pl-[13px] pr-3 shadow-[0_14px_34px_rgb(0_0_0_/_38%)] backdrop-blur-[10px]"
          style={{ animationDelay: `${index * 160}ms` }}
        >
          <span className="absolute inset-y-0 left-0 w-[3px] bg-amber shadow-[0_0_12px_rgb(241_199_109_/_55%)]" />
          <span className="font-mono text-[0.48rem] font-bold tracking-[0.14em] text-[#8a7442]">WAIT</span>
          <span
            className={`grid size-[22px] shrink-0 place-items-center rounded-md border font-mono text-[0.56rem] font-extrabold ${agent.badgeClass}`}
          >
            {agent.monogram}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-[1px]">
            <strong className="min-w-0 overflow-hidden text-[0.66rem] font-bold text-ellipsis whitespace-nowrap text-[#f3e7c3]">
              {agent.name}
            </strong>
            <small className="overflow-hidden font-mono text-[0.52rem] text-ellipsis whitespace-nowrap text-[#d9b36b]">
              {agent.stateLabel}
            </small>
          </div>
          <span className="shrink-0 font-mono text-[0.5rem] text-[#8a7442]">{agent.time}</span>
          <button
            className="shrink-0 rounded-md border border-[#5a4a24] bg-[rgb(38_30_12_/_70%)] px-2 py-[5px] font-mono text-[0.56rem] font-bold text-[#f1d9a0] transition-colors hover:border-amber hover:text-amber"
            type="button"
            aria-label={`Open ${agent.name}`}
          >
            open
          </button>
        </div>
      ))}
    </div>
  );
}
