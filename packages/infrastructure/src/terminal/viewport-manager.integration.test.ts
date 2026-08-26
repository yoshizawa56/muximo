// Integration tests exercise the terminal adapter at its boundary.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Assertion,
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { type PtyProcess, spawnPty } from "./pty.js";
import { TmuxAdapter } from "./tmux.js";
import { TmuxViewportManager } from "./viewport-manager.js";

const canUseRealTmux = probeIsolatedTmux();
type IntegrationStep = { type: "run" };
type IntegrationFixture = {
  tmux: RealTmuxFixture;
  pty?: PtyProcess;
  manager?: TmuxViewportManager;
  selectedPaneId?: string;
  stagedZoomed: boolean;
  stagedSelected: boolean;
  stagedVisible: boolean;
  finalZoomed: boolean;
  finalSelected: boolean;
  finalVisible: boolean;
  clientSelected: boolean;
  outputHasErase: boolean;
  afterSplitZoomed: boolean;
  afterSplitSelected: boolean;
  afterSplitVisible: boolean;
  afterSplitCwd: string;
  expectedCwd: string;
  desktopStatus: string;
  desktopStatusAfterRelease: string;
  mobileStatus: string;
  mobileDefaultCommand: string;
  mobileManagedSessionId: string;
  mobileManagedMarker: string;
  mobileSessionVisible: boolean;
  sourceDefaultCommandAfterRelease: string;
  sourceManagedSessionIdAfterRelease: string;
  output: string;
};
type IntegrationContext = Omit<IntegrationFixture, "tmux" | "pty" | "manager" | "selectedPaneId" | "output">;

const splitInheritsCwd: Assertion<IntegrationContext, undefined> = {
  name: "creates the split in the target pane cwd",
  check: (ctx) => expect(ctx.afterSplitCwd).toBe(ctx.expectedCwd),
};

const integrationFixture = (): FixtureHandle<IntegrationFixture> => {
  const tmux = new RealTmuxFixture();
  const fixture: IntegrationFixture = {
    tmux,
    stagedZoomed: false,
    stagedSelected: false,
    stagedVisible: false,
    finalZoomed: false,
    finalSelected: false,
    finalVisible: false,
    clientSelected: false,
    outputHasErase: false,
    afterSplitZoomed: false,
    afterSplitSelected: false,
    afterSplitVisible: false,
    afterSplitCwd: "",
    expectedCwd: "",
    desktopStatus: "",
    desktopStatusAfterRelease: "",
    mobileStatus: "",
    mobileDefaultCommand: "",
    mobileManagedSessionId: "",
    mobileManagedMarker: "",
    mobileSessionVisible: false,
    sourceDefaultCommandAfterRelease: "",
    sourceManagedSessionIdAfterRelease: "",
    output: "",
  };
  fixture.expectedCwd = realpathSync(tmux.directory);
  return {
    fixture,
    cleanup: async () => {
      await fixture.pty?.kill();
      fixture.manager?.dispose();
      fixture.tmux.dispose();
    },
  };
};

const cases = [
  {
    name: "attaches a selected split pane as one fully redrawn viewport",
    steps: [{ type: "run" }],
    assert: [
      hasObserved<IntegrationContext, undefined>("stagedZoomed", true),
      hasObserved<IntegrationContext, undefined>("stagedSelected", true),
      hasObserved<IntegrationContext, undefined>("stagedVisible", true),
      hasObserved<IntegrationContext, undefined>("finalZoomed", true),
      hasObserved<IntegrationContext, undefined>("finalSelected", true),
      hasObserved<IntegrationContext, undefined>("finalVisible", true),
      hasObserved<IntegrationContext, undefined>("clientSelected", true),
      hasObserved<IntegrationContext, undefined>("outputHasErase", true),
      hasObserved<IntegrationContext, undefined>("afterSplitZoomed", true),
      hasObserved<IntegrationContext, undefined>("afterSplitSelected", true),
      hasObserved<IntegrationContext, undefined>("afterSplitVisible", true),
      splitInheritsCwd,
      hasObserved<IntegrationContext, undefined>("desktopStatus", "on"),
      hasObserved<IntegrationContext, undefined>("desktopStatusAfterRelease", "on"),
      hasObserved<IntegrationContext, undefined>("mobileStatus", "off"),
      hasObserved<IntegrationContext, undefined>("mobileDefaultCommand", "source-default-command"),
      hasObserved<IntegrationContext, undefined>("mobileManagedSessionId", "managed-issue11"),
      hasObserved<IntegrationContext, undefined>("mobileManagedMarker", "1"),
      hasObserved<IntegrationContext, undefined>("mobileSessionVisible", false),
      hasObserved<IntegrationContext, undefined>("sourceDefaultCommandAfterRelease", "source-default-command"),
      hasObserved<IntegrationContext, undefined>("sourceManagedSessionIdAfterRelease", "managed-issue11"),
    ],
  },
] satisfies readonly ScenarioCase<"default", IntegrationStep, undefined, IntegrationContext>[];

const table: ScenarioTable<IntegrationFixture, "default", IntegrationStep, undefined, IntegrationContext> = {
  defaultFixture: integrationFixture,
  cases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type !== "run") continue;
      fixture.selectedPaneId = fixture.tmux.createSplitWindow();
      fixture.manager = new TmuxViewportManager(fixture.tmux.adapter);
      const prepared = await fixture.manager.prepare(fixture.selectedPaneId, "/tmp", 80, 24);
      const staged = fixture.tmux.adapter.snapshotWindow(prepared.pane);
      fixture.stagedZoomed = staged.zoomed;
      fixture.stagedSelected = staged.activePaneId === fixture.selectedPaneId;
      fixture.stagedVisible = !staged.visibleLayout.includes("{");
      fixture.pty = await spawnPty("tmux", fixture.tmux.adapter.attachArgs(prepared.attachTarget), {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd: "/tmp",
        env: { ...process.env, TERM: "xterm-256color" },
      });
      const pty = fixture.pty;
      pty.onData((data) => {
        fixture.output += data;
      });
      const lease = await prepared.attach({ ptyPid: pty.pid, cols: 80, rows: 24, onEvent: () => undefined });
      await delay(100);
      const final = fixture.tmux.adapter.snapshotWindow(prepared.pane);
      const client = fixture.tmux.adapter.findClientByPid(pty.pid);
      fixture.finalZoomed = final.zoomed;
      fixture.finalSelected = final.activePaneId === fixture.selectedPaneId;
      fixture.finalVisible = !final.visibleLayout.includes("{");
      fixture.clientSelected = client?.paneId === fixture.selectedPaneId;
      fixture.outputHasErase = fixture.output.includes("\u001b[K");
      fixture.desktopStatus = fixture.tmux.readSessionStatus(prepared.pane.sessionName);
      fixture.mobileStatus = fixture.tmux.readSessionStatus(prepared.attachTarget);
      fixture.mobileDefaultCommand = fixture.tmux.readSessionOption(prepared.attachTarget, "default-command");
      fixture.mobileManagedSessionId = fixture.tmux.readSessionEnvironment(
        prepared.attachTarget,
        "MUXIMOD_MANAGED_SESSION_ID",
      );
      fixture.mobileManagedMarker = fixture.tmux.readSessionOption(prepared.attachTarget, "@muximod.managed");
      fixture.mobileSessionVisible = fixture.tmux.adapter
        .listPanesSnapshot()
        .panes.some((pane) => pane.sessionName.startsWith("muximo-mobile-"));
      fixture.tmux.adapter.splitWindow(undefined, "right", fixture.selectedPaneId, true);
      await fixture.manager.reassertMobileViewport(fixture.selectedPaneId);
      await delay(100);
      const afterSplit = fixture.tmux.adapter.snapshotWindow(prepared.pane);
      fixture.afterSplitCwd =
        fixture.tmux.adapter.listPanesSnapshot().panes.find((pane) => pane.paneId === fixture.tmux.splitPaneId)?.cwd ??
        "";
      fixture.afterSplitZoomed = afterSplit.zoomed;
      fixture.afterSplitSelected = afterSplit.activePaneId === fixture.selectedPaneId;
      fixture.afterSplitVisible = !afterSplit.visibleLayout.includes("{");
      await lease.release();
      fixture.desktopStatusAfterRelease = fixture.tmux.readSessionStatus(prepared.pane.sessionName);
      fixture.sourceDefaultCommandAfterRelease = fixture.tmux.readSessionOption(
        prepared.pane.sessionName,
        "default-command",
      );
      fixture.sourceManagedSessionIdAfterRelease = fixture.tmux.readSessionEnvironment(
        prepared.pane.sessionName,
        "MUXIMOD_MANAGED_SESSION_ID",
      );
    }
  },
  observe: (fixture) => ({
    expectedCwd: fixture.expectedCwd,
    stagedZoomed: fixture.stagedZoomed,
    stagedSelected: fixture.stagedSelected,
    stagedVisible: fixture.stagedVisible,
    finalZoomed: fixture.finalZoomed,
    finalSelected: fixture.finalSelected,
    finalVisible: fixture.finalVisible,
    clientSelected: fixture.clientSelected,
    outputHasErase: fixture.outputHasErase,
    afterSplitZoomed: fixture.afterSplitZoomed,
    afterSplitSelected: fixture.afterSplitSelected,
    afterSplitVisible: fixture.afterSplitVisible,
    afterSplitCwd: fixture.afterSplitCwd,
    desktopStatus: fixture.desktopStatus,
    desktopStatusAfterRelease: fixture.desktopStatusAfterRelease,
    mobileStatus: fixture.mobileStatus,
    mobileDefaultCommand: fixture.mobileDefaultCommand,
    mobileManagedSessionId: fixture.mobileManagedSessionId,
    mobileManagedMarker: fixture.mobileManagedMarker,
    mobileSessionVisible: fixture.mobileSessionVisible,
    sourceDefaultCommandAfterRelease: fixture.sourceDefaultCommandAfterRelease,
    sourceManagedSessionIdAfterRelease: fixture.sourceManagedSessionIdAfterRelease,
  }),
};

describe.skipIf(!canUseRealTmux)("real tmux mobile viewport fixture", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

class RealTmuxFixture {
  public readonly directory = mkdtempSync(join(tmpdir(), "muximo-tmux-"));
  public readonly socketPath = join(this.directory, "server.sock");
  public readonly adapter = new TmuxAdapter(this.socketPath, "/dev/null");
  public splitPaneId?: string;
  public constructor() {
    this.require(["new-session", "-d", "-s", "issue11", "-x", "120", "-y", "40", "-c", this.directory]);
    this.require(["set-option", "-t", "=issue11:", "default-command", "source-default-command"]);
    this.require(["set-environment", "-t", "=issue11", "MUXIMOD_MANAGED_SESSION_ID", "managed-issue11"]);
    this.require(["set-option", "-t", "=issue11:", "@muximod.managed", "1"]);
  }
  public createSplitWindow(): string {
    const original = this.adapter.resolvePane("issue11:0.0");
    const split = this.adapter.splitWindow(undefined, "right", original.paneId);
    this.splitPaneId = split;
    this.require(["send-keys", "-t", original.paneId, "printf LEFT_LAYOUT", "Enter"]);
    this.require(["send-keys", "-t", split, "printf SELECTED_PANE", "Enter"]);
    return split;
  }
  public dispose(): void {
    try {
      this.adapter.require(["kill-server"]);
    } catch {
      /* tmux may already be gone */
    }
    rmSync(this.directory, { recursive: true, force: true });
  }
  public readSessionStatus(target: string): string {
    return this.adapter.require(["display-message", "-p", "-t", target, "#{status}"]).trim();
  }
  public readSessionOption(target: string, name: string): string {
    return this.adapter.require(["show-options", "-v", "-t", target, name]).trim();
  }
  public readSessionEnvironment(target: string, name: string): string {
    return this.adapter
      .require(["show-environment", "-t", target, name])
      .trim()
      .slice(name.length + 1);
  }
  private require(args: string[]): void {
    this.adapter.require(args);
  }
}

function probeIsolatedTmux(): boolean {
  const directory = mkdtempSync(join(tmpdir(), "muximo-tmux-probe-"));
  const socketPath = join(directory, "server.sock");
  try {
    const result = spawnSync(
      "tmux",
      ["-f", "/dev/null", "-S", socketPath, "new-session", "-d", "-s", "probe", "-c", "/tmp"],
      { stdio: "ignore" },
    );
    if (result.status !== 0 || !existsSync(socketPath)) return false;
    spawnSync("tmux", ["-f", "/dev/null", "-S", socketPath, "kill-server"], { stdio: "ignore" });
    return true;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
