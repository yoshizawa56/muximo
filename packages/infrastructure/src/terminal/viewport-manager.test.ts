// Tests for the terminal adapter stay co-located with its implementation.

import {
  type FixtureHandle,
  hasError,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  TmuxAdapter,
  type TmuxClient,
  type TmuxPaneRef,
  type TmuxWindowMouse,
  type TmuxWindowSize,
  type TmuxWindowSnapshot,
} from "./tmux.js";
import {
  type PreparedViewport,
  TmuxViewportManager,
  type ViewportEvent,
  type ViewportLease,
} from "./viewport-manager.js";

type ViewportStep =
  | { type: "prepare"; cols?: number; rows?: number }
  | { type: "attach"; cols: number; rows: number }
  | { type: "claim" }
  | { type: "resize"; cols: number; rows: number }
  | { type: "desktop-activity" }
  | { type: "desktop-size"; width: number; height: number }
  | { type: "hook"; event: "client-active" | "client-resized" | "client-focus-in" }
  | { type: "release" }
  | { type: "clear-mobile-zoom" }
  | { type: "reassert" }
  | { type: "poll" }
  | { type: "unfocus" };
type ViewportFixtureKey = "default" | "missing";
type ViewportFixture = {
  adapter: FakeTmuxAdapter;
  manager: TmuxViewportManager;
  events: ViewportEvent[];
  prepared?: PreparedViewport;
  lease?: ViewportLease;
};
type ViewportContext = {
  width: number;
  height: number;
  zoomed: boolean;
  activePaneId: string;
  desktopFlags: string;
  windowSize: TmuxWindowSize;
  mouse: TmuxWindowMouse;
  events: readonly ViewportEvent[];
  refreshes: readonly string[];
  resizes: readonly [number, number][];
  ensureSessionCalls: readonly string[];
};

const viewportFixture = (): FixtureHandle<ViewportFixture> => {
  const adapter = new FakeTmuxAdapter();
  const manager = new TmuxViewportManager(adapter);
  const fixture: ViewportFixture = { adapter, manager, events: [] };
  return { fixture, cleanup: () => manager.dispose() };
};

const missingViewportFixture = (): FixtureHandle<ViewportFixture> => {
  const result = viewportFixture();
  result.fixture.adapter.missingTarget = true;
  return result;
};

const attach = { type: "attach" as const, cols: 80, rows: 24 };
const prepare = { type: "prepare" as const };
const cases = [
  {
    name: "does not create a missing target session during prepare",
    fixture: "missing",
    steps: [prepare],
    assert: [
      hasError<ViewportContext, undefined>({ message: "Could not resolve tmux pane: muximod" }),
      hasObserved<ViewportContext, undefined>("ensureSessionCalls", []),
    ],
  },
  {
    name: "enters a phone-sized zoomed viewport without changing desktop state",
    steps: [prepare, attach],
    assert: [
      hasObserved<ViewportContext, undefined>("activePaneId", "%0"),
      hasObserved<ViewportContext, undefined>("desktopFlags", "attached,focused,active-pane"),
      hasObserved<ViewportContext, undefined>("events", [{ owner: "mobile", reason: "attached" }]),
      hasObserved<ViewportContext, undefined>("width", 80),
      hasObserved<ViewportContext, undefined>("height", 24),
      hasObserved<ViewportContext, undefined>("zoomed", true),
      hasObserved<ViewportContext, undefined>("mouse", "on"),
    ],
  },
  {
    name: "returns to the desktop viewport when desktop becomes active",
    steps: [prepare, attach, { type: "desktop-activity" }, { type: "hook", event: "client-active" }],
    assert: [
      hasObserved<ViewportContext, undefined>("activePaneId", "%1"),
      hasObserved<ViewportContext, undefined>("desktopFlags", "attached,focused"),
      hasObserved<ViewportContext, undefined>("events", [
        { owner: "mobile", reason: "attached" },
        { owner: "desktop", reason: "desktop_activity" },
      ]),
      hasObserved<ViewportContext, undefined>("width", 120),
      hasObserved<ViewportContext, undefined>("height", 40),
      hasObserved<ViewportContext, undefined>("zoomed", false),
    ],
  },
  {
    name: "restores the original layout when the phone disconnects first",
    steps: [prepare, attach, { type: "release" }],
    assert: [
      hasObserved<ViewportContext, undefined>("activePaneId", "%1"),
      hasObserved<ViewportContext, undefined>("windowSize", "latest"),
      hasObserved<ViewportContext, undefined>("events", [
        { owner: "mobile", reason: "attached" },
        { owner: "desktop", reason: "detached" },
      ]),
      hasObserved<ViewportContext, undefined>("zoomed", false),
      hasObserved<ViewportContext, undefined>("mouse", "off"),
    ],
  },
  {
    name: "does not restore a stale phone snapshot after desktop takeover",
    steps: [
      prepare,
      attach,
      { type: "desktop-size", width: 100, height: 30 },
      { type: "hook", event: "client-resized" },
      { type: "release" },
    ],
    assert: [
      hasObserved<ViewportContext, undefined>("width", 100),
      hasObserved<ViewportContext, undefined>("height", 30),
      hasObserved<ViewportContext, undefined>("activePaneId", "%1"),
      hasObserved<ViewportContext, undefined>("zoomed", false),
    ],
  },
  {
    name: "reapplies the mobile zoom after a split clears the window zoom",
    steps: [prepare, attach, { type: "clear-mobile-zoom" }, { type: "reassert" }],
    assert: [
      hasObserved<ViewportContext, undefined>("zoomed", true),
      hasObserved<ViewportContext, undefined>("activePaneId", "%0"),
    ],
  },
  {
    name: "stages the selected pane before the mobile client receives its first draw",
    steps: [
      { type: "prepare", cols: 96, rows: 32 },
      { type: "attach", cols: 96, rows: 32 },
    ],
    assert: [
      hasObserved<ViewportContext, undefined>("width", 96),
      hasObserved<ViewportContext, undefined>("height", 32),
      hasObserved<ViewportContext, undefined>("zoomed", true),
      hasObserved<ViewportContext, undefined>("activePaneId", "%0"),
      hasObserved<ViewportContext, undefined>("refreshes", ["/dev/mobile"]),
    ],
  },
  {
    name: "hands control to the desktop once for repeated takeover hooks",
    steps: [
      prepare,
      attach,
      { type: "hook", event: "client-resized" },
      { type: "hook", event: "client-focus-in" },
      { type: "hook", event: "client-active" },
    ],
    assert: [
      hasObserved<ViewportContext, undefined>("events", [
        { owner: "mobile", reason: "attached" },
        { owner: "desktop", reason: "desktop_resize" },
      ]),
    ],
  },
  {
    name: "does not mistake background tmux activity for desktop input",
    steps: [prepare, attach, { type: "desktop-activity" }, { type: "poll" }],
    assert: [hasObserved<ViewportContext, undefined>("zoomed", true)],
  },
  {
    name: "ignores an unfocused client-active hook from viewport commands",
    steps: [prepare, attach, { type: "unfocus" }, { type: "hook", event: "client-active" }],
    assert: [hasObserved<ViewportContext, undefined>("zoomed", true)],
  },
  {
    name: "does not touch tmux for a bare claim while the mobile client owns the viewport",
    steps: [prepare, attach, { type: "claim" }, { type: "claim" }, { type: "claim" }],
    assert: [
      hasObserved<ViewportContext, undefined>("refreshes", ["/dev/mobile"]),
      hasObserved<ViewportContext, undefined>("resizes", [[80, 24]]),
      hasObserved<ViewportContext, undefined>("width", 80),
      hasObserved<ViewportContext, undefined>("zoomed", true),
    ],
  },
  {
    name: "does not re-resize or redraw when resized to the current size",
    steps: [prepare, attach, { type: "resize", cols: 80, rows: 24 }, { type: "resize", cols: 80, rows: 24 }],
    assert: [
      hasObserved<ViewportContext, undefined>("refreshes", ["/dev/mobile"]),
      hasObserved<ViewportContext, undefined>("resizes", [[80, 24]]),
      hasObserved<ViewportContext, undefined>("width", 80),
      hasObserved<ViewportContext, undefined>("height", 24),
    ],
  },
  {
    name: "resizes and redraws once when the mobile size actually changes",
    steps: [prepare, attach, { type: "resize", cols: 90, rows: 30 }],
    assert: [
      hasObserved<ViewportContext, undefined>("resizes", [
        [80, 24],
        [90, 30],
      ]),
      hasObserved<ViewportContext, undefined>("refreshes", ["/dev/mobile", "/dev/mobile"]),
      hasObserved<ViewportContext, undefined>("width", 90),
      hasObserved<ViewportContext, undefined>("height", 30),
    ],
  },
  {
    name: "reclaims the viewport from a desktop takeover with a bare claim",
    steps: [prepare, attach, { type: "hook", event: "client-active" }, { type: "claim" }],
    assert: [
      hasObserved<ViewportContext, undefined>("width", 80),
      hasObserved<ViewportContext, undefined>("height", 24),
      hasObserved<ViewportContext, undefined>("zoomed", true),
      hasObserved<ViewportContext, undefined>("activePaneId", "%0"),
      hasObserved<ViewportContext, undefined>("events", [
        { owner: "mobile", reason: "attached" },
        { owner: "desktop", reason: "desktop_activity" },
        { owner: "mobile", reason: "mobile_claim" },
      ]),
      hasObserved<ViewportContext, undefined>("refreshes", ["/dev/mobile", "/dev/desktop", "/dev/mobile"]),
    ],
  },
] satisfies readonly ScenarioCase<ViewportFixtureKey, ViewportStep, undefined, ViewportContext>[];

const table: ScenarioTable<ViewportFixture, ViewportFixtureKey, ViewportStep, undefined, ViewportContext> = {
  defaultFixture: viewportFixture,
  fixtures: { default: viewportFixture, missing: missingViewportFixture },
  cases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "prepare")
        fixture.prepared = await fixture.manager.prepare("muximod", "/tmp", step.cols, step.rows);
      if (step.type === "attach")
        fixture.lease = await fixture.prepared!.attach({
          ptyPid: 200,
          cols: step.cols,
          rows: step.rows,
          onEvent: (event) => fixture.events.push(event),
        });
      if (step.type === "claim") await fixture.lease?.claimMobile();
      if (step.type === "resize") await fixture.lease?.resize(step.cols, step.rows);
      if (step.type === "desktop-activity") fixture.adapter.desktop.activity += 1;
      if (step.type === "desktop-size") {
        fixture.adapter.desktop.width = step.width;
        fixture.adapter.desktop.height = step.height;
      }
      if (step.type === "hook") await fixture.manager.handleTmuxHook(step.event, fixture.adapter.desktop.name);
      if (step.type === "release") await fixture.lease?.release();
      if (step.type === "clear-mobile-zoom") {
        fixture.adapter.state.zoomed = false;
        fixture.adapter.state.activePaneId = "%1";
      }
      if (step.type === "reassert") await fixture.manager.reassertMobileViewport("%0");
      if (step.type === "poll")
        await (fixture.manager as unknown as { pollDesktopClients: () => Promise<void> }).pollDesktopClients();
      if (step.type === "unfocus")
        fixture.adapter.desktop.flags = fixture.adapter.desktop.flags.replace(",focused", "");
    }
  },
  observe: (fixture) => ({
    width: fixture.adapter.state.width,
    height: fixture.adapter.state.height,
    zoomed: fixture.adapter.state.zoomed,
    activePaneId: fixture.adapter.state.activePaneId,
    desktopFlags: fixture.adapter.desktop.flags,
    windowSize: fixture.adapter.state.windowSize,
    mouse: fixture.adapter.state.mouse,
    events: [...fixture.events],
    refreshes: [...fixture.adapter.refreshes],
    resizes: [...fixture.adapter.resizeCalls],
    ensureSessionCalls: fixture.adapter.ensureSessionCalls.map(({ target }) => target),
  }),
};

describe("tmux viewport manager", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

class FakeTmuxAdapter extends TmuxAdapter {
  public missingTarget = false;
  public readonly ensureSessionCalls: Array<{ target: string; cwd: string }> = [];
  public readonly state = {
    width: 120,
    height: 40,
    zoomed: false,
    activePaneId: "%1",
    layout: "layout-120x40",
    windowSize: "latest" as TmuxWindowSize,
    mouse: "off" as TmuxWindowMouse,
  };
  public readonly refreshes: string[] = [];
  public readonly resizeCalls: Array<[number, number]> = [];
  public readonly desktop: TmuxClient = {
    name: "/dev/desktop",
    pid: 100,
    tty: "/dev/desktop",
    sessionName: "muximod",
    windowId: "@0",
    paneId: "%1",
    width: 120,
    height: 40,
    flags: "attached,focused",
    activity: 1,
  };
  private readonly mobile: TmuxClient = {
    name: "/dev/mobile",
    pid: 200,
    tty: "/dev/mobile",
    sessionName: "muximod",
    windowId: "@0",
    paneId: "%0",
    width: 80,
    height: 24,
    flags: "attached,active-pane",
    activity: 2,
  };
  public constructor() {
    super("/private/tmp/muximo-fake.sock");
  }
  public override resolvePane(target: string): TmuxPaneRef {
    if (this.missingTarget) throw new Error(`Could not resolve tmux pane: ${target}`);
    return { paneId: "%0", windowId: "@0", sessionName: "muximod" };
  }
  public override ensureSession(target: string, cwd: string): boolean {
    this.ensureSessionCalls.push({ target, cwd });
    return false;
  }
  public override snapshotWindow(pane: TmuxPaneRef): TmuxWindowSnapshot {
    return {
      ...pane,
      layout: this.state.layout,
      visibleLayout: this.state.layout,
      zoomed: this.state.zoomed,
      activePaneId: this.state.activePaneId,
      width: this.state.width,
      height: this.state.height,
      windowSize: this.state.windowSize,
      mouse: this.state.mouse,
    };
  }
  public override findClientByPid(pid: number): TmuxClient | undefined {
    return pid === this.mobile.pid ? this.mobile : undefined;
  }
  public override listClients(): TmuxClient[] {
    return [this.mobile, this.desktop];
  }
  public override clientView(clientName: string): TmuxClient {
    return clientName === this.mobile.name ? this.mobile : this.desktop;
  }
  public override setWindowSize(_windowId: string, value: TmuxWindowSize): void {
    this.state.windowSize = value;
  }
  public override setWindowMouse(_windowId: string, value: TmuxWindowMouse): void {
    this.state.mouse = value;
  }
  public override resizeWindow(_windowId: string, width: number, height: number): void {
    this.resizeCalls.push([width, height]);
    this.state.width = width;
    this.state.height = height;
  }
  public override switchClient(_clientName: string, targetPane: string): void {
    this.state.activePaneId = targetPane;
  }
  public override setClientFlags(clientName: string, flags: string): void {
    if (clientName !== this.desktop.name) return;
    const current = new Set(this.desktop.flags.split(",").filter(Boolean));
    for (const flag of flags.split(",")) {
      if (flag.startsWith("!")) current.delete(flag.slice(1));
      else current.add(flag);
    }
    this.desktop.flags = [...current].join(",");
  }
  public override refreshClient(clientName: string): void {
    this.refreshes.push(clientName);
  }
  public override zoomPane(targetPane: string): void {
    this.state.zoomed = !this.state.zoomed;
    this.state.activePaneId = targetPane;
  }
  public override selectLayout(_windowId: string, layout: string): void {
    this.state.layout = layout;
    this.state.zoomed = false;
  }
  public override selectPane(paneId: string): void {
    this.state.activePaneId = paneId;
  }
  public override restoreSnapshot(snapshot: TmuxWindowSnapshot): void {
    this.state.layout = snapshot.layout;
    this.state.width = snapshot.width;
    this.state.height = snapshot.height;
    this.state.zoomed = snapshot.zoomed;
    this.state.activePaneId = snapshot.activePaneId;
    this.state.windowSize = snapshot.windowSize;
    this.state.mouse = snapshot.mouse;
  }
}
