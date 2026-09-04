// Tests for the terminal adapter stay co-located with its implementation.

import { PaneId } from "@muximo/domain";
import {
  type FixtureHandle,
  hasError,
  hasNoError,
  hasObserved,
  noFixture,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { TmuxPane } from "./tmux.js";
import { TmuxStateMonitor } from "./tmux-state.js";

type TimerInput = { kind: "tmux-poll" | "pane-cleanup" | "pane-retention"; milliseconds: number };
type TimerContext = {};

const timerCases = [
  {
    name: "accepts a one-second tmux poll interval",
    input: { kind: "tmux-poll", milliseconds: 1_000 },
    assert: [hasNoError<TimerContext, TmuxStateMonitor>()],
  },
  {
    name: "rejects a sub-second tmux poll interval",
    input: { kind: "tmux-poll", milliseconds: 999 },
    assert: [hasError<TimerContext, TmuxStateMonitor>({ message: "tmux poll interval must be an integer >= 1000" })],
  },
  {
    name: "accepts a one-second pane cleanup interval",
    input: { kind: "pane-cleanup", milliseconds: 1_000 },
    assert: [hasNoError<TimerContext, TmuxStateMonitor>()],
  },
  {
    name: "rejects a sub-second pane cleanup interval",
    input: { kind: "pane-cleanup", milliseconds: 999 },
    assert: [hasError<TimerContext, TmuxStateMonitor>({ message: "pane cleanup interval must be an integer >= 1000" })],
  },
  {
    name: "accepts zero as the explicit pane retention sentinel",
    input: { kind: "pane-retention", milliseconds: 0 },
    assert: [hasNoError<TimerContext, TmuxStateMonitor>()],
  },
  {
    name: "rejects a sub-second pane retention duration",
    input: { kind: "pane-retention", milliseconds: 999 },
    assert: [hasError<TimerContext, TmuxStateMonitor>({ message: "pane retention must be 0 or an integer >= 1000" })],
  },
] satisfies readonly OperationCase<"default", TimerInput, TmuxStateMonitor, TimerContext>[];

const timerTable: OperationTable<undefined, "default", TimerInput, TmuxStateMonitor, TimerContext> = {
  defaultFixture: noFixture(),
  cases: timerCases,
  execute: (_fixture, input) =>
    new TmuxStateMonitor({
      readPanes: () => ({ panes: [], available: false, tmuxServerId: null, tmuxServerScope: null }),
      synchronize: async () => [],
      onChange: () => undefined,
      ...(input.kind === "tmux-poll"
        ? { intervalMs: input.milliseconds }
        : input.kind === "pane-cleanup"
          ? { cleanupIntervalMs: input.milliseconds }
          : { paneRetentionMs: input.milliseconds }),
    }),
  observe: () => ({}),
};

type StateKey = "default" | "cleanup-cadence" | "unavailable" | "cleanup-error" | "agent-observation" | "managed-agent";
type StateStep =
  | { type: "reconcile" }
  | { type: "add"; paneIds: string[] }
  | { type: "replace"; paneId: string; replacementPaneId: string }
  | { type: "delete" }
  | { type: "change" }
  | { type: "change-state"; state: string }
  | { type: "change-output"; output: string }
  | { type: "change-workspace"; workspaceId: string }
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
  synchronizeCalls: number;
  heartbeatCalls: string[][];
};
type StateContext = {
  changes: readonly { sessionName: string; reason: string }[];
  cleanups: readonly CleanupRecord[];
  synchronizeCalls: number;
  heartbeatCalls: readonly string[][];
};

const stateFixture =
  (kind: StateKey): (() => FixtureHandle<StateFixture>) =>
  () => ({
    fixture: {
      panes: [
        createPane("%1", "work", kind === "agent-observation" ? "codex" : "zsh", {
          ...(kind === "managed-agent"
            ? { muximodKind: "agent", muximodSessionId: "session-1", muximodExecutionId: "execution-1" }
            : {}),
        }),
      ],
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
      synchronizeCalls: 0,
      heartbeatCalls: [],
    },
  });

const cases = [
  {
    name: "does not re-reconcile an unchanged shell snapshot",
    steps: [{ type: "reconcile" }, { type: "reconcile" }],
    assert: [
      hasObserved<StateContext, undefined>("synchronizeCalls", 1),
      hasObserved<StateContext, undefined>("heartbeatCalls", [["%1"]]),
    ],
  },
  {
    name: "reconciles an equivalent pane replacement",
    steps: [{ type: "reconcile" }, { type: "replace", paneId: "%1", replacementPaneId: "%2" }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("synchronizeCalls", 2)],
  },
  {
    name: "continues observing an agent on an unchanged tmux snapshot",
    fixture: "agent-observation",
    steps: [{ type: "reconcile" }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("synchronizeCalls", 2)],
  },
  {
    name: "reconciles a managed agent without tmux changes for liveness",
    fixture: "managed-agent",
    steps: [{ type: "reconcile" }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("synchronizeCalls", 2)],
  },
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
    fixture: "agent-observation",
    steps: [{ type: "reconcile" }, { type: "change-state", state: "waiting_input" }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("changes", [{ sessionName: "work", reason: "pane_changed" }])],
  },
  {
    name: "reports a provider output change",
    fixture: "agent-observation",
    steps: [{ type: "reconcile" }, { type: "change-output", output: "new output" }, { type: "reconcile" }],
    assert: [hasObserved<StateContext, undefined>("changes", [{ sessionName: "work", reason: "pane_changed" }])],
  },
  {
    name: "reports a workspace metadata change",
    steps: [{ type: "reconcile" }, { type: "change-workspace", workspaceId: "workspace-2" }, { type: "reconcile" }],
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
    "agent-observation": stateFixture("agent-observation"),
    "managed-agent": stateFixture("managed-agent"),
  },
  cases,
  execute: async (fixture, steps) => {
    const monitor = new TmuxStateMonitor({
      readPanes: () =>
        fixture.available
          ? liveSnapshot(fixture.panes)
          : { panes: [], available: false, tmuxServerId: null, tmuxServerScope: null },
      synchronize: async (snapshot) => {
        fixture.synchronizeCalls += 1;
        return {
          activePaneIds: snapshot.panes.map((pane) => PaneId.create(pane.paneId)),
          paneStates: new Map(
            snapshot.panes.map((pane) => [pane.paneId, fixture.paneStates.get(pane.paneId) ?? "running"]),
          ),
          paneRecentOutputs: new Map(
            snapshot.panes.map((pane) => [pane.paneId, fixture.paneRecentOutputs.get(pane.paneId)]),
          ),
        };
      },
      heartbeat: async (snapshot) => {
        fixture.heartbeatCalls.push(snapshot.panes.map((pane) => pane.paneId));
      },
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
        case "replace":
          fixture.panes = [
            ...fixture.panes.filter((pane) => pane.paneId !== step.paneId),
            createPane(step.replacementPaneId, "work"),
          ];
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
        case "change-workspace":
          fixture.panes[0] = { ...fixture.panes[0]!, muximodWorkspaceId: step.workspaceId };
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
  observe: (fixture) => ({
    changes: [...fixture.changes],
    cleanups: [...fixture.cleanups],
    synchronizeCalls: fixture.synchronizeCalls,
    heartbeatCalls: fixture.heartbeatCalls.map((paneIds) => [...paneIds]),
  }),
};

describe("tmux state monitor", () => {
  const register = it as unknown as TestRegistrar;
  runOperationTable(register, timerTable);
  runScenarioTable(register, table);
});

function assertNever(value: never): never {
  throw new Error(`unhandled tmux state step: ${String(value)}`);
}

function createPane(paneId: string, sessionName: string, command = "zsh", overrides: Partial<TmuxPane> = {}): TmuxPane {
  return {
    paneId,
    windowId: "@0",
    sessionName,
    tmuxServerId: "server-1",
    windowName: "shell",
    windowIndex: 0,
    paneIndex: 0,
    cwd: "/tmp",
    command,
    title: command,
    active: true,
    left: 0,
    top: 0,
    width: 80,
    height: 24,
    windowWidth: 80,
    windowHeight: 24,
    ...overrides,
  };
}

function liveSnapshot(panes: TmuxPane[]) {
  return { panes, available: true, tmuxServerId: "server-1", tmuxServerScope: "scope-1" };
}
