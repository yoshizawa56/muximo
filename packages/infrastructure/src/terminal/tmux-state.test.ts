// Tests for the terminal adapter stay co-located with its implementation.

import { PaneId } from "@muximo/domain";
import {
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { TmuxPane } from "./tmux.js";
import { TmuxStateMonitor } from "./tmux-state.js";

type StateKey = "default" | "cleanup-cadence" | "unavailable" | "cleanup-error";
type StateStep =
  | { type: "reconcile" }
  | { type: "add"; paneIds: string[] }
  | { type: "delete" }
  | { type: "change" }
  | { type: "change-state"; state: string }
  | { type: "change-output"; output: string }
  | { type: "advance"; milliseconds: number }
  | { type: "set-available"; available: boolean };
type CleanupRecord = { ids: string[]; olderThan: string };
type StateFixture = {
  panes: TmuxPane[];
  paneStates: Map<string, string>;
  paneRecentOutputs: Map<string, string | undefined>;
  changes: Array<{ sessionName: string; reason: string }>;
  cleanups: CleanupRecord[];
  available: boolean;
  now: number;
  cleanupIntervalMs?: number;
  paneRetentionMs?: number;
  cleanupEnabled: boolean;
  cleanupThrows: boolean;
};
type StateContext = { changes: readonly { sessionName: string; reason: string }[]; cleanups: readonly CleanupRecord[] };

const stateFixture =
  (kind: StateKey): (() => FixtureHandle<StateFixture>) =>
  () => ({
    fixture: {
      panes: [createPane("%1", "work")],
      paneStates: new Map(),
      paneRecentOutputs: new Map(),
      changes: [],
      cleanups: [],
      available: true,
      now: kind === "cleanup-cadence" ? 1_000 : 0,
      cleanupIntervalMs: kind === "cleanup-cadence" ? 1_000 : undefined,
      paneRetentionMs: kind === "cleanup-cadence" ? 10_000 : undefined,
      cleanupEnabled: true,
      cleanupThrows: kind === "cleanup-error",
    },
  });

const cases = [
  {
    name: "reports a pane created after the initial snapshot",
    steps: [{ type: "reconcile" }, { type: "add", paneIds: ["%2"] }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("changes", [{ sessionName: "work", reason: "pane_created" }])],
  },
  {
    name: "reports a pane deleted after the initial snapshot",
    steps: [{ type: "reconcile" }, { type: "delete" }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("changes", [{ sessionName: "work", reason: "pane_deleted" }])],
  },
  {
    name: "reports a changed pane without sending its contents",
    steps: [{ type: "reconcile" }, { type: "change" }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("changes", [{ sessionName: "work", reason: "pane_changed" }])],
  },
  {
    name: "reports a pane state change",
    steps: [{ type: "reconcile" }, { type: "change-state", state: "waiting_input" }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("changes", [{ sessionName: "work", reason: "pane_changed" }])],
  },
  {
    name: "reports a provider output change",
    steps: [{ type: "reconcile" }, { type: "change-output", output: "new output" }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("changes", [{ sessionName: "work", reason: "pane_changed" }])],
  },
  {
    name: "coalesces multiple pane changes in one session",
    steps: [{ type: "reconcile" }, { type: "add", paneIds: ["%2", "%3"] }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("changes", [{ sessionName: "work", reason: "pane_created" }])],
  },
  {
    name: "cleans stale records on a slower cadence",
    fixture: "cleanup-cadence",
    steps: [
      { type: "reconcile" },
      { type: "advance", milliseconds: 999 },
      { type: "reconcile" },
      { type: "advance", milliseconds: 1 },
      { type: "reconcile" },
    ],
    assert: [
      hasObserved<StateContext, undefined>("cleanups", [
        { ids: ["%1"], olderThan: new Date(-9_000).toISOString() },
        { ids: ["%1"], olderThan: new Date(-8_000).toISOString() },
      ]),
    ],
  },
  {
    name: "does not clean while tmux is unavailable",
    fixture: "unavailable",
    steps: [{ type: "reconcile" }, { type: "set-available", available: false }, { type: "reconcile" }],
    assert: [
      hasObserved<StateContext, undefined>("cleanups", [{ ids: ["%1"], olderThan: new Date(-600_000).toISOString() }]),
      hasObserved<StateContext, undefined>("changes", []),
    ],
  },
  {
    name: "keeps reconciliation working when cleanup fails",
    fixture: "cleanup-error",
    steps: [{ type: "reconcile" }, { type: "change" }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("changes", [{ sessionName: "work", reason: "pane_changed" }])],
  },
] satisfies readonly ScenarioCase<StateKey, StateStep, undefined, StateContext>[];

const table: ScenarioTable<StateFixture, StateKey, StateStep, undefined, StateContext> = {
  defaultFixture: stateFixture("default"),
  fixtures: {
    default: stateFixture("default"),
    "cleanup-cadence": stateFixture("cleanup-cadence"),
    unavailable: stateFixture("unavailable"),
    "cleanup-error": stateFixture("cleanup-error"),
  },
  cases,
  execute: async (fixture, steps) => {
    const monitor = new TmuxStateMonitor({
      readPanes: () =>
        fixture.available
          ? liveSnapshot(fixture.panes)
          : { panes: [], available: false, tmuxServerId: null, tmuxServerScope: null },
      synchronize: async (snapshot) => ({
        activePaneIds: snapshot.panes.map((pane) => PaneId.create(pane.paneId)),
        paneStates: new Map(
          snapshot.panes.map((pane) => [pane.paneId, fixture.paneStates.get(pane.paneId) ?? "running"]),
        ),
        paneRecentOutputs: new Map(
          snapshot.panes.map((pane) => [pane.paneId, fixture.paneRecentOutputs.get(pane.paneId)]),
        ),
      }),
      cleanup: fixture.cleanupEnabled
        ? async (ids, olderThan) => {
            fixture.cleanups.push({ ids: [...ids], olderThan });
            if (fixture.cleanupThrows) throw new Error("database locked");
          }
        : undefined,
      onChange: (changes) => fixture.changes.push(...changes),
      cleanupIntervalMs: fixture.cleanupIntervalMs,
      paneRetentionMs: fixture.paneRetentionMs,
      now: () => fixture.now,
    });
    for (const step of steps) {
      switch (step.type) {
        case "reconcile":
          await monitor.reconcile();
          break;
        case "add":
          fixture.panes.push(...step.paneIds.map((paneId) => createPane(paneId, "work")));
          break;
        case "delete":
          fixture.panes = [];
          break;
        case "change":
          fixture.panes[0] = { ...fixture.panes[0]!, title: "changed" };
          break;
        case "change-state":
          fixture.paneStates.set(fixture.panes[0]!.paneId, step.state);
          break;
        case "change-output":
          fixture.paneRecentOutputs.set(fixture.panes[0]!.paneId, step.output);
          break;
        case "advance":
          fixture.now += step.milliseconds;
          break;
        case "set-available":
          fixture.available = step.available;
          break;
        default:
          assertNever(step);
      }
    }
  },
  observe: (fixture) => ({ changes: [...fixture.changes], cleanups: [...fixture.cleanups] }),
};

describe("tmux state monitor", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

function assertNever(value: never): never {
  throw new Error(`unhandled tmux state step: ${String(value)}`);
}

function createPane(paneId: string, sessionName: string): TmuxPane {
  return {
    paneId,
    windowId: "@0",
    sessionName,
    tmuxServerId: "server-1",
    windowName: "shell",
    windowIndex: 0,
    paneIndex: 0,
    cwd: "/tmp",
    command: "zsh",
    title: "zsh",
    active: true,
    left: 0,
    top: 0,
    width: 80,
    height: 24,
    windowWidth: 80,
    windowHeight: 24,
  };
}

function liveSnapshot(panes: TmuxPane[]) {
  return { panes, available: true, tmuxServerId: "server-1", tmuxServerScope: "scope-1" };
}
