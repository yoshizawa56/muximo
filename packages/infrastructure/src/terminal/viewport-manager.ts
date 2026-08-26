// Viewport policy is kept beside its tmux I/O because both are one terminal adapter boundary.

import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import type {
  AttachViewportOptions,
  PreparedViewport,
  TerminalProcessSpec,
  ViewportEvent,
  ViewportLease,
  ViewportOwner,
  ViewportReason,
} from "./contracts.js";
import { TmuxAdapter, type TmuxClient, type TmuxPaneRef, type TmuxWindowSnapshot } from "./tmux.js";

export type {
  AttachViewportOptions,
  PreparedViewport,
  TerminalProcessSpec,
  TerminalViewportPort,
  ViewportEvent,
  ViewportLease,
  ViewportOwner,
  ViewportReason,
} from "./contracts.js";

type LeaseRecord = {
  id: string;
  target: string;
  pane: TmuxPaneRef;
  mobileSessionName: string;
  mobileAttachTarget: string;
  snapshot: TmuxWindowSnapshot;
  owner: ViewportOwner;
  ptyPid?: number;
  mobileClient?: TmuxClient;
  mobileCols: number;
  mobileRows: number;
  latestDesktop?: TmuxClient;
  desktopClientFlags: Map<string, string>;
  onEvent?: (event: ViewportEvent) => void;
  released: boolean;
  lastSeenLayout?: string;
};

type TmuxHookEvent = "client-attached" | "client-active" | "client-resized" | "client-focus-in" | "client-detached";

/**
 * Coordinates the one shared tmux window viewport used by the mobile client.
 *
 * The mobile client attaches through a temporary grouped session so session
 * options such as the status line stay isolated from the desktop session. The
 * terminal itself remains a normal tmux client. This class owns the temporary
 * window-size/zoom changes and restores them when the mobile client leaves or
 * desktop activity takes ownership back.
 */
export class TmuxViewportManager {
  private readonly adapter: TmuxAdapter;
  private readonly leases = new Map<string, LeaseRecord>();
  private monitorTimer: NodeJS.Timeout | undefined;
  private monitorBusy = false;
  private hookRegistration: { index: number; names: string[] } | undefined;
  private disposed = false;

  public constructor(adapter = new TmuxAdapter()) {
    this.adapter = adapter;
  }

  public get tmux(): TmuxAdapter {
    return this.adapter;
  }

  public buildAttachProcess(target: string): TerminalProcessSpec {
    return { file: "tmux", args: this.adapter.attachArgs(target) };
  }

  /**
   * Reasserts the mobile zoom after a topology-changing tmux command such as
   * split-window. tmux may clear the zoom flag while creating the new pane,
   * even though the existing mobile client is still attached.
   */
  public async reassertMobileViewport(target: string): Promise<void> {
    let pane: TmuxPaneRef;
    try {
      pane = this.adapter.resolvePane(target);
    } catch {
      return;
    }

    const record = this.leases.get(pane.windowId);
    if (!record || record.released || record.owner !== "mobile") return;

    try {
      this.reconcileMobileViewport(record, record.mobileCols, record.mobileRows);
    } catch {
      // The pane may disappear immediately after a desktop-side split/exit.
      // The next terminal attach or claim will retry from a fresh snapshot.
    }
  }

  public async prepare(target: string, _cwd: string, cols = 80, rows = 24): Promise<PreparedViewport> {
    if (this.disposed) throw new Error("Viewport manager has been disposed");

    const pane = this.adapter.resolvePane(target);

    if (this.leases.has(pane.windowId)) {
      throw new Error(`Viewport is already in use for tmux window: ${pane.windowId}`);
    }

    const snapshot = this.adapter.snapshotWindow(pane);
    const id = createLeaseId();
    const mobileSessionName = `muximo-mobile-${id}`;
    this.adapter.createGroupedSession(pane.sessionName, mobileSessionName);
    const record: LeaseRecord = {
      id,
      target,
      pane,
      mobileSessionName,
      mobileAttachTarget: `=${mobileSessionName}:${pane.windowId}.${pane.paneId}`,
      snapshot,
      owner: "mobile",
      mobileCols: cols,
      mobileRows: rows,
      desktopClientFlags: new Map(),
      released: false,
    };
    this.leases.set(pane.windowId, record);

    // Establish the exact mobile window state before a PTY is attached. tmux
    // sends its first screen immediately when attach-session starts; waiting
    // until after the client appears allows the old split layout to reach the
    // terminal emulator and leaves a redraw race for the later zoom command.
    try {
      // `status` is a session option. The grouped session shares the source
      // session's windows but keeps this option private to the mobile client.
      this.adapter.setSessionOption(`=${mobileSessionName}`, "status", "off");
      this.primeMobileViewport(record, cols, rows);
    } catch (error) {
      this.releaseRecord(record);
      throw error;
    }

    this.startMonitor();

    return {
      target,
      pane,
      attachTarget: record.mobileAttachTarget,
      snapshot,
      attach: (options) => this.attach(record, options),
      release: async () => this.releaseRecord(record),
    };
  }

  /**
   * Receives notifications from tmux hooks. Polling remains as a fallback for
   * environments where the user's tmux cannot execute the local hook command.
   */
  public async handleTmuxHook(event: TmuxHookEvent, clientName: string): Promise<void> {
    if (this.disposed || !clientName) return;

    const lease = [...this.leases.values()].find((candidate) => candidate.mobileClient?.name === clientName);
    if (lease) {
      if (event === "client-detached") this.releaseRecord(lease);
      return;
    }

    if (
      event !== "client-attached" &&
      event !== "client-active" &&
      event !== "client-resized" &&
      event !== "client-focus-in"
    )
      return;

    let client: TmuxClient;
    try {
      client = this.adapter.clientView(clientName);
    } catch {
      return;
    }

    // tmux can emit client-active for a client while muximod is changing the
    // shared window (for example during switch-client/resize-window). That
    // does not mean the desktop terminal received focus. The focused flag is
    // the stable signal for a real desktop takeover; resize hooks remain
    // actionable even when the terminal does not report focus events.
    if (event === "client-active" && !hasTmuxClientFlag(client, "focused")) return;

    // A client can move between windows in the same session. Only a hook for
    // the leased window is allowed to take ownership; falling back to the
    // session would let activity in another window resize the wrong lease.
    const candidate = [...this.leases.values()].find(
      (current) => current.pane.windowId === client.windowId && current.pane.sessionName === client.sessionName,
    );
    if (!candidate) return;
    // A prepared lease has already staged the shared window, but its mobile
    // PTY has not necessarily appeared in tmux yet. Ignore desktop hooks in
    // that small interval; there is no mobile client to hand control back to.
    if (!candidate.mobileClient || candidate.ptyPid === client.pid) return;

    const reason: ViewportReason =
      event === "client-resized"
        ? "desktop_resize"
        : event === "client-focus-in"
          ? "desktop_focus"
          : "desktop_activity";
    this.claimDesktop(candidate, client, reason);
  }

  public configureHooks(baseUrl: string, token: string): void {
    if (this.hookRegistration || this.disposed) return;
    const curl = findCurl();
    if (!curl) return;

    const index = this.nextHookIndex();
    const names: TmuxHookEvent[] = [
      "client-attached",
      "client-active",
      "client-resized",
      "client-focus-in",
      "client-detached",
    ];
    try {
      for (const name of names) {
        const command = [
          curl,
          "-fsS",
          "--max-time",
          "1",
          "-X",
          "POST",
          "-H",
          shellQuote(`x-muximod-hook-token: ${token}`),
          "--data-urlencode",
          shellQuote(`event=${name}`),
          "--data-urlencode",
          shellQuote("client=#{hook_client}"),
          shellQuote(baseUrl),
          ">/dev/null",
          "2>&1",
          "|| true",
        ].join(" ");
        this.adapter.setHook(name, index, `run-shell -b ${shellQuote(command)}`);
      }
    } catch {
      for (const name of names) {
        try {
          this.adapter.unsetHook(name, index);
        } catch {
          // tmux may not be running yet. The polling fallback will still work.
        }
      }
      return;
    }
    this.hookRegistration = { index, names };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = undefined;

    if (this.hookRegistration) {
      for (const name of this.hookRegistration.names) {
        try {
          this.adapter.unsetHook(name, this.hookRegistration.index);
        } catch {
          // The tmux server may already have exited during shutdown.
        }
      }
      this.hookRegistration = undefined;
    }

    for (const lease of [...this.leases.values()]) this.releaseRecord(lease);
  }

  private async attach(record: LeaseRecord, options: AttachViewportOptions): Promise<ViewportLease> {
    if (record.released) throw new Error("Viewport preparation has already been released");
    record.ptyPid = options.ptyPid;
    record.mobileCols = options.cols;
    record.mobileRows = options.rows;
    record.onEvent = options.onEvent;

    const client = await this.waitForClient(options.ptyPid);
    if (record.released) throw new Error("Viewport preparation was released while attaching");
    record.mobileClient = client;

    // Set this only after the client exists; an unattached grouped session can
    // otherwise be collected before the PTY has a chance to attach. This also
    // cleans up after a crashed muximod process; normal release still kills it
    // explicitly.
    try {
      this.adapter.setSessionOption(`=${record.mobileSessionName}`, "destroy-unattached", "on");
    } catch {
      // Explicit release remains the primary cleanup path if tmux rejects it.
    }

    this.protectDesktopClients(record);
    // The client has just received its first draw from tmux. Force one
    // authoritative redraw so xterm cannot retain cells from the pre-zoom
    // split, regardless of whether the window already matched the request.
    this.reconcileMobileViewport(record, options.cols, options.rows, true);
    this.rememberLatestDesktop(record);
    this.emit(record, "mobile", "attached");

    return {
      id: record.id,
      target: record.target,
      paneId: record.pane.paneId,
      windowId: record.pane.windowId,
      sessionName: record.pane.sessionName,
      claimMobile: async (cols, rows) => {
        this.claimMobile(record, cols, rows);
      },
      resize: async (cols, rows) => {
        this.resizeMobile(record, cols ?? record.mobileCols, rows ?? record.mobileRows);
      },
      release: async () => this.releaseRecord(record),
    };
  }

  private primeMobileViewport(record: LeaseRecord, cols: number, rows: number): void {
    this.protectDesktopClients(record);
    this.reconcileMobileViewport(record, cols, rows);
  }

  private reconcileMobileViewport(record: LeaseRecord, cols: number, rows: number, forceRefresh = false): void {
    const clamped = clampViewportSize(cols, rows);
    cols = clamped.cols;
    rows = clamped.rows;
    record.owner = "mobile";
    record.mobileCols = cols;
    record.mobileRows = rows;

    // Mobile touch scrolling is forwarded as terminal mouse-wheel input. Keep
    // tmux mouse handling enabled for the lifetime of this viewport lease.
    this.adapter.setWindowMouse(record.pane.windowId, "on");
    this.adapter.setWindowSize(record.pane.windowId, "manual");

    const current = this.adapter.snapshotWindow(record.pane);
    const sizeChanged = current.width !== cols || current.height !== rows;
    if (sizeChanged) {
      this.adapter.resizeWindow(record.pane.windowId, cols, rows);
    }

    const topologyChanged = !current.zoomed || current.activePaneId !== record.pane.paneId;
    if (topologyChanged) {
      if (current.zoomed) this.adapter.selectLayout(record.pane.windowId, current.layout);
      this.adapter.selectPane(record.pane.paneId);
      this.adapter.zoomPane(record.pane.paneId);
    }
    // Remember the mobile-expected layout so a desktop-side split/resize
    // (which does not change client focus/size) can still be detected as
    // desktop activity. Without this, pane sizes would not hand back.
    try {
      record.lastSeenLayout = this.adapter.snapshotWindow(record.pane).layout;
    } catch {
      record.lastSeenLayout = undefined;
    }

    if (record.mobileClient) {
      let client = record.mobileClient;
      try {
        client = this.adapter.clientView(record.mobileClient.name);
      } catch {
        // The client may disappear during a reconnect. The final refresh below
        // will fail and the caller can release this lease for a clean retry.
      }
      const clientChanged = client.windowId !== record.pane.windowId || client.paneId !== record.pane.paneId;
      if (clientChanged) {
        this.adapter.switchClient(record.mobileClient.name, record.pane.paneId, true);
      }
      // The viewport commands above can be delivered as incremental terminal
      // updates. Reset and redraw once after the authoritative state is in
      // place so xterm cannot retain cells from the pre-zoom split. In the
      // steady state the client only needs the natural pane-output diffs,
      // exactly like a direct SSH session; forcing a full redraw here would
      // interleave screen replays with every input echo.
      if (forceRefresh || sizeChanged || topologyChanged || clientChanged) {
        this.adapter.refreshClient(record.mobileClient.name);
      }
    }
  }

  private claimMobile(record: LeaseRecord, cols?: number, rows?: number): void {
    if (record.released) return;
    const nextCols = cols ?? record.mobileCols;
    const nextRows = rows ?? record.mobileRows;

    if (record.owner !== "mobile") {
      record.snapshot = this.adapter.snapshotWindow(record.pane);
      record.owner = "mobile";
      this.protectDesktopClients(record);
      this.reconcileMobileViewport(record, nextCols, nextRows);
      this.emit(record, "mobile", "mobile_claim");
      return;
    }

    if (cols === undefined && rows === undefined) {
      // The mobile client already owns the viewport. A bare claim is sent
      // with every input frame; it must not run any tmux command. The
      // terminal is a pure I/O device here: only a desktop takeover needs
      // reconciliation, and that path is taken above.
      return;
    }

    this.resizeMobile(record, nextCols, nextRows);
  }

  private resizeMobile(record: LeaseRecord, cols: number, rows: number): void {
    if (record.released) return;
    if (record.owner !== "mobile") {
      this.claimMobile(record, cols, rows);
      return;
    }
    if (cols === record.mobileCols && rows === record.mobileRows) return;
    this.reconcileMobileViewport(record, cols, rows);
  }

  private claimDesktop(record: LeaseRecord, client: TmuxClient, reason: ViewportReason): void {
    if (record.released || !record.mobileClient || record.mobileClient.name === client.name) return;
    if (!isValidClientSize(client)) return;

    const clampedClient = clampViewportSize(client.width, client.height);
    const effectiveClient: TmuxClient = { ...client, width: clampedClient.cols, height: clampedClient.rows };

    if (record.owner === "desktop") {
      const previous = record.latestDesktop;
      record.latestDesktop = effectiveClient;
      if (
        !previous ||
        previous.name !== effectiveClient.name ||
        previous.width !== effectiveClient.width ||
        previous.height !== effectiveClient.height
      ) {
        this.adapter.setWindowSize(record.pane.windowId, "manual");
        this.adapter.resizeWindow(record.pane.windowId, effectiveClient.width, effectiveClient.height);
        this.adapter.refreshClient(effectiveClient.name);
      }
      return;
    }

    if (record.owner === "mobile") {
      const current = this.adapter.snapshotWindow(record.pane);
      // A desktop client is temporarily given the active-pane flag while the
      // mobile lease is active. tmux's client formats can still report the
      // window-level active pane for that client, so use the pane captured at
      // lease acquisition for the protected client.
      const desktopPaneId = record.desktopClientFlags.has(effectiveClient.name)
        ? record.snapshot.activePaneId
        : effectiveClient.paneId;
      const pcChangedPane = desktopPaneId && desktopPaneId !== record.snapshot.activePaneId;

      if (record.snapshot.zoomed && !pcChangedPane) {
        this.adapter.restoreSnapshot(record.snapshot, effectiveClient);
      } else {
        // window_layout deliberately ignores the zoomed visible layout. This
        // removes the mobile zoom while preserving any layout change made by
        // the desktop client before the hook reached muximod.
        this.adapter.selectLayout(current.windowId, current.layout);
        if (desktopPaneId) this.adapter.selectPane(desktopPaneId);
        this.adapter.setWindowMouse(record.pane.windowId, record.snapshot.mouse);
      }
      this.restoreDesktopClientFlags(record);
    }

    record.owner = "desktop";
    record.latestDesktop = effectiveClient;
    this.adapter.setWindowSize(record.pane.windowId, "manual");
    this.adapter.resizeWindow(record.pane.windowId, effectiveClient.width, effectiveClient.height);
    this.adapter.refreshClient(effectiveClient.name);
    this.emit(record, "desktop", reason);
  }

  private releaseRecord(record: LeaseRecord): void {
    if (record.released) return;
    record.released = true;
    const clientsToRefresh = new Set(record.desktopClientFlags.keys());
    if (record.latestDesktop) clientsToRefresh.add(record.latestDesktop.name);

    try {
      if (record.owner === "mobile") {
        this.adapter.restoreSnapshot(record.snapshot);
      } else {
        // A desktop takeover is authoritative. Do not put an old pane/layout
        // back over changes the user made after taking control.
        this.adapter.setWindowSize(record.pane.windowId, record.snapshot.windowSize);
        this.adapter.setWindowMouse(record.pane.windowId, record.snapshot.mouse);
      }
      this.restoreDesktopClientFlags(record);
    } catch {
      // Best effort during disconnect/shutdown. The periodic reconciliation on
      // the next attach will take a fresh snapshot.
    }
    for (const clientName of clientsToRefresh) {
      try {
        this.adapter.refreshClient(clientName);
      } catch {
        // The desktop client may have detached already.
      }
    }

    try {
      this.adapter.killSession(`=${record.mobileSessionName}`);
    } catch {
      // destroy-unattached or a concurrent tmux shutdown may have removed it.
    }

    this.leases.delete(record.pane.windowId);
    this.emit(record, "desktop", "detached");
    if (this.leases.size === 0 && this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
  }

  private emit(record: LeaseRecord, owner: ViewportOwner, reason: ViewportReason): void {
    record.onEvent?.({ owner, reason });
  }

  private startMonitor(): void {
    if (this.monitorTimer || this.disposed) return;
    this.monitorTimer = setInterval(() => {
      void this.pollDesktopClients().catch(() => undefined);
    }, 250);
    this.monitorTimer.unref?.();
  }

  private async pollDesktopClients(): Promise<void> {
    if (this.monitorBusy || this.disposed || this.leases.size === 0) return;
    this.monitorBusy = true;
    try {
      const clients = this.adapter.listClients();
      for (const record of this.leases.values()) {
        if (!record.mobileClient || record.released) continue;
        const desktop = clients.find(
          (client) =>
            client.name !== record.mobileClient?.name &&
            client.windowId === record.pane.windowId &&
            client.sessionName === record.pane.sessionName,
        );
        if (!desktop) continue;

        if (record.owner === "mobile") {
          // client_activity is not an input-only signal. tmux can update it
          // while forwarding pane output or while muximod changes the shared
          // viewport, which would immediately steal control back from the
          // phone after a successful attach. Explicit client hooks handle
          // desktop input; polling only covers focus and size changes.
          const focusChanged =
            !record.latestDesktop ||
            hasTmuxClientFlag(record.latestDesktop, "focused") !== hasTmuxClientFlag(desktop, "focused");
          const sizeChanged =
            !record.latestDesktop ||
            record.latestDesktop.width !== desktop.width ||
            record.latestDesktop.height !== desktop.height;
          let layoutChanged = false;
          if (record.lastSeenLayout) {
            try {
              const currentLayout = this.adapter.snapshotWindow(record.pane).layout;
              layoutChanged = currentLayout !== record.lastSeenLayout;
            } catch {
              layoutChanged = false;
            }
          }
          if (focusChanged || sizeChanged || layoutChanged) {
            this.claimDesktop(
              record,
              desktop,
              sizeChanged ? "desktop_resize" : layoutChanged ? "desktop_activity" : "desktop_focus",
            );
          }
        } else if (
          record.latestDesktop?.name === desktop.name &&
          (record.latestDesktop.width !== desktop.width || record.latestDesktop.height !== desktop.height)
        ) {
          if (!isValidClientSize(desktop)) continue;
          const clamped = clampViewportSize(desktop.width, desktop.height);
          record.latestDesktop = { ...desktop, width: clamped.cols, height: clamped.rows };
          this.adapter.resizeWindow(record.pane.windowId, clamped.cols, clamped.rows);
          this.adapter.refreshClient(desktop.name);
        }
      }
    } catch {
      // tmux may be unavailable temporarily during a server restart. The PTY
      // connection remains alive and the next poll retries reconciliation.
    } finally {
      this.monitorBusy = false;
    }
  }

  private rememberLatestDesktop(record: LeaseRecord): void {
    try {
      const clients = this.adapter.listClients();
      record.latestDesktop = clients.find(
        (client) =>
          client.name !== record.mobileClient?.name &&
          client.windowId === record.pane.windowId &&
          client.sessionName === record.pane.sessionName,
      );
    } catch {
      record.latestDesktop = undefined;
    }
  }

  private protectDesktopClients(record: LeaseRecord): void {
    try {
      const clients = this.adapter
        .listClients()
        .filter(
          (client) =>
            client.name !== record.mobileClient?.name &&
            client.windowId === record.pane.windowId &&
            client.sessionName === record.pane.sessionName,
        );
      for (const client of clients) {
        if (!record.desktopClientFlags.has(client.name)) {
          record.desktopClientFlags.set(client.name, client.flags);
        }
        if (!hasTmuxClientFlag(client, "active-pane")) {
          this.adapter.setClientFlags(client.name, "active-pane");
        }
      }
    } catch {
      // The client can disappear during attach. Polling/hooks still reconcile
      // the viewport, and the remaining clients are restored best-effort.
    }
  }

  private restoreDesktopClientFlags(record: LeaseRecord): void {
    for (const [clientName, flags] of record.desktopClientFlags) {
      if (flags.split(",").includes("active-pane")) continue;
      try {
        this.adapter.setClientFlags(clientName, "!active-pane");
      } catch {
        // The desktop client may have detached already.
      }
    }
    record.desktopClientFlags.clear();
  }

  private async waitForClient(pid: number): Promise<TmuxClient> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      try {
        const client = this.adapter.findClientByPid(pid);
        if (client) return client;
      } catch {
        // The tmux server may need one tick to publish the newly attached client.
      }
      await delay(50);
    }
    throw new Error(`Could not identify tmux client for PTY process ${pid}`);
  }

  private nextHookIndex(): number {
    return randomInt(100_000, 999_999);
  }
}

function createLeaseId(): string {
  return `viewport-${Date.now().toString(36)}-${randomInt(100_000, 999_999).toString(36)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findCurl(): string | undefined {
  const result = spawnSync("sh", ["-lc", "command -v curl"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const path = result.stdout?.trim();
  return result.status === 0 && path ? path : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hasTmuxClientFlag(client: TmuxClient, flag: string): boolean {
  return client.flags.split(",").includes(flag);
}

function clampViewportSize(cols: number, rows: number): { cols: number; rows: number } {
  const clampedCols = Math.max(20, Math.min(Math.trunc(cols) || 80, 500));
  const clampedRows = Math.max(5, Math.min(Math.trunc(rows) || 24, 300));
  return { cols: clampedCols, rows: clampedRows };
}

function isValidClientSize(client: TmuxClient): boolean {
  return (
    Number.isInteger(client.width) &&
    Number.isInteger(client.height) &&
    client.width >= 20 &&
    client.width <= 500 &&
    client.height >= 5 &&
    client.height <= 300
  );
}
