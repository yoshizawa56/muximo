// Polling and stale-pane observation are terminal infrastructure concerns.
import type { PaneId } from "@muximo/domain";
import type { TmuxLiveSnapshot, TmuxPane } from "./tmux.js";

export type TmuxPaneChangeReason = "pane_created" | "pane_deleted" | "pane_changed";

export type TmuxPaneChange = {
  sessionName: string;
  reason: TmuxPaneChangeReason;
};

export type TmuxSynchronization = {
  activePaneIds: readonly PaneId[];
  /** Live state emitted by the provider while synchronizing the pane projection. */
  paneStates?: ReadonlyMap<string, string>;
  /** Live provider output tails used to invalidate clients when they change. */
  paneRecentOutputs?: ReadonlyMap<string, string | undefined>;
};

export type TmuxStateMonitorOptions = {
  readPanes: () => TmuxLiveSnapshot;
  synchronize: (snapshot: TmuxLiveSnapshot) => Promise<readonly PaneId[] | TmuxSynchronization>;
  cleanup?: (activePaneIds: readonly PaneId[], olderThan: string, tmuxServerScope: string) => Promise<void>;
  onChange: (changes: TmuxPaneChange[]) => void;
  intervalMs?: number;
  cleanupIntervalMs?: number;
  paneRetentionMs?: number;
  now?: () => number;
};

export const defaultTmuxPollIntervalMs = 1_000;
export const defaultPaneCleanupIntervalMs = 60_000;
export const defaultPaneRetentionMs = 10 * 60_000;

/**
 * Polls tmux as the live source of truth and reports coalesced changes.
 *
 * Polling is intentionally used as the first implementation. It sees panes
 * created by either muximod or an arbitrary desktop tmux client and does not
 * depend on every tmux hook being installed or delivered.
 */
export class TmuxStateMonitor {
  private readonly intervalMs: number;
  private previous = new Map<string, PaneSnapshot>();
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private initialized = false;
  private readonly cleanupIntervalMs: number;
  private readonly paneRetentionMs: number;
  private readonly now: () => number;
  private lastCleanupAttemptAt = Number.NEGATIVE_INFINITY;

  public constructor(private readonly options: TmuxStateMonitorOptions) {
    this.intervalMs = Math.max(1, options.intervalMs ?? defaultTmuxPollIntervalMs);
    this.cleanupIntervalMs = Math.max(1, options.cleanupIntervalMs ?? defaultPaneCleanupIntervalMs);
    this.paneRetentionMs = Math.max(0, options.paneRetentionMs ?? defaultPaneRetentionMs);
    this.now = options.now ?? Date.now;
  }

  public start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcile();
    }, this.intervalMs);
    this.timer.unref?.();
    void this.reconcile();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  public async reconcile(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const live = this.options.readPanes();
      if (!live.available) return;
      const synchronization = await this.options.synchronize(live);
      const synchronized = "activePaneIds" in synchronization
        ? synchronization
        : { activePaneIds: synchronization };
      const activePaneIds = synchronized.activePaneIds;
      const paneStates = "paneStates" in synchronized ? synchronized.paneStates : undefined;
      const paneRecentOutputs = "paneRecentOutputs" in synchronized ? synchronized.paneRecentOutputs : undefined;
      const current = snapshot(live.panes, paneStates, paneRecentOutputs);
      if (!this.initialized) {
        this.previous = current;
        this.initialized = true;
      } else {
        const changes = diff(this.previous, current, live.panes);
        this.previous = current;
        if (changes.length) this.options.onChange(changes);
      }

      await this.cleanupIfDue(live, activePaneIds);
    } catch {
      // A tmux server can disappear between reads. Keep the previous snapshot
      // so a later successful read can still produce the appropriate change.
    } finally {
      this.busy = false;
    }
  }

  private async cleanupIfDue(live: TmuxLiveSnapshot, activePaneIds: readonly PaneId[]): Promise<void> {
    if (!this.options.cleanup || !live.available || !live.tmuxServerId || !live.tmuxServerScope || live.panes.length === 0 || activePaneIds.length === 0) return;

    const now = this.now();
    if (now - this.lastCleanupAttemptAt < this.cleanupIntervalMs) return;
    this.lastCleanupAttemptAt = now;

    try {
      const olderThan = new Date(now - this.paneRetentionMs).toISOString();
      await this.options.cleanup(activePaneIds, olderThan, live.tmuxServerScope);
    } catch {
      // Cleanup is best effort. A database lock or transient SQLite failure
      // must not stop live tmux reconciliation or event delivery.
    }
  }
}

type PaneSnapshot = {
  sessionName: string;
  fingerprint: string;
};

function snapshot(panes: TmuxPane[], paneStates?: ReadonlyMap<string, string>, paneRecentOutputs?: ReadonlyMap<string, string | undefined>): Map<string, PaneSnapshot> {
  return new Map(panes.map((pane) => [pane.paneId, { sessionName: pane.sessionName, fingerprint: paneFingerprint(pane, paneStates?.get(pane.paneId), paneRecentOutputs?.get(pane.paneId)) }]));
}

function paneFingerprint(pane: TmuxPane, state?: string, recentOutput?: string): string {
  return JSON.stringify([
    pane.sessionName,
    pane.tmuxServerId,
    pane.muximodSessionId,
    pane.muximodExecutionId,
    pane.windowId,
    pane.windowName,
    pane.windowIndex,
    pane.paneIndex,
    pane.cwd,
    pane.command,
    pane.title,
    pane.active,
    pane.left,
    pane.top,
    pane.width,
    pane.height,
    pane.windowWidth,
    pane.windowHeight,
    pane.muximodPaneId,
    pane.muximodName,
    pane.muximodKind,
    pane.muximodAgentId,
    pane.muximodManagedSessionId,
    state,
    recentOutput,
  ]);
}

function diff(previous: Map<string, PaneSnapshot>, current: Map<string, PaneSnapshot>, panes: TmuxPane[]): TmuxPaneChange[] {
  const currentById = new Map(panes.map((pane) => [pane.paneId, pane]));
  const changes = new Map<string, TmuxPaneChange>();

  for (const [paneId, snapshot] of current) {
    const prior = previous.get(paneId);
    if (prior === undefined) {
      const pane = currentById.get(paneId);
      if (pane) changes.set(pane.sessionName, { sessionName: pane.sessionName, reason: "pane_created" });
    } else if (prior.fingerprint !== snapshot.fingerprint) {
      const pane = currentById.get(paneId);
      if (pane) {
        changes.set(pane.sessionName, { sessionName: pane.sessionName, reason: "pane_changed" });
        if (prior.sessionName !== pane.sessionName) {
          changes.set(prior.sessionName, { sessionName: prior.sessionName, reason: "pane_changed" });
        }
      }
    }
  }

  for (const [paneId, prior] of previous) {
    if (current.has(paneId)) continue;
    changes.set(prior.sessionName, { sessionName: prior.sessionName, reason: "pane_deleted" });
  }

  return [...changes.values()];
}
