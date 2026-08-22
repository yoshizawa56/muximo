import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { AgentObservation } from "../index.js";
import { type OpenCodeEvent, type OpenCodeSessionStatus, OpenCodeStreamClosedError } from "./client.js";
import { OpenCodeMonitor, type OpenCodeMonitorClient, openCodeMonitorActions } from "./monitor.js";

const primarySessionId = "session-primary";

type MonitorInput = {
  sessionId?: string;
  workspaceRoot?: string;
  queue: readonly OpenCodeEvent[];
  /** Number of initial stream failures before the stream succeeds. */
  streamFailures?: number;
  sessionExists?: boolean;
  sessionStatus?: OpenCodeSessionStatus;
  /** When false the stream stays open so the test can feed more events. */
  endAfterDrain?: boolean;
  /** Runs after start, before the drain wait (for action execution). */
  afterStart?: (context: {
    monitor: OpenCodeMonitor;
    observations: AgentObservation[];
    state: FakeState;
  }) => Promise<void>;
};

type FakeState = {
  queue: OpenCodeEvent[];
  streamFailures: number;
  sessionExists: boolean;
  sessionStatus: OpenCodeSessionStatus | undefined;
  endAfterDrain: boolean;
  generatorEnded: boolean;
  started: boolean;
  drainedIndex: number;
  aborted: boolean;
  streamSignals: number;
  streamAborted: boolean;
  permissionCalls: { sessionId: string; permissionId: string; response: "allow" | "deny"; remember: boolean }[];
  abortCalls: number;
};

type EmptyContext = {};

type MonitorContext = {
  streamSignals: number;
  streamAborted: boolean;
};

type MonitorResult = {
  states: readonly string[];
  actions: readonly { id: string; metadata?: Record<string, unknown> }[];
  permissionCalls: FakeState["permissionCalls"];
  aborted: boolean;
  abortCalls: number;
};

const cases = [
  {
    name: "maps session busy and idle to running and waiting input",
    input: {
      queue: [statusEvent("busy"), statusEvent("idle")],
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["running", "waiting_input"],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "does not emit waiting input for a freshly created idle session",
    input: { queue: [idleEvent()] },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: [],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "maps a session retry to running",
    input: { queue: [statusEvent("retry")] },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["running"],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "maps a permission request to waiting approval with approve and reject actions",
    input: {
      queue: [permissionEvent("permission-1", "Allow bash")],
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["waiting_approval"],
        actions: [
          { id: "approve", metadata: { permissionID: "permission-1", title: "Allow bash" } },
          { id: "reject", metadata: { permissionID: "permission-1", title: "Allow bash" } },
        ],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "maps a permission reply back to running",
    input: {
      queue: [permissionEvent("permission-1", "Allow bash"), replyEvent("permission-1")],
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["waiting_approval", "running"],
        actions: [
          { id: "approve", metadata: { permissionID: "permission-1", title: "Allow bash" } },
          { id: "reject", metadata: { permissionID: "permission-1", title: "Allow bash" } },
        ],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "maps a primary session error to failed",
    input: {
      queue: [errorEvent(primarySessionId, "APIError")],
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["failed"],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "ignores a global session error without a session id",
    input: { queue: [errorEvent(undefined, "APIError")] },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: [],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "ignores child session events",
    input: {
      queue: [
        { type: "session.status", properties: { sessionID: "session-child", status: { type: "busy" } } },
        { type: "session.idle", properties: { sessionID: "session-child" } },
      ],
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: [],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "ignores events from another directory",
    input: {
      workspaceRoot: "/workspace",
      queue: [{ type: "session.idle", properties: { sessionID: primarySessionId }, directory: "/other" }],
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: [],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "ignores unknown and sessionless event types",
    input: {
      queue: [
        { type: "server.connected", properties: {} },
        { type: "file.edited", properties: { file: "README.md" } },
        { type: "todo.updated", properties: { sessionID: primarySessionId, todos: [] } },
      ],
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: [],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "deduplicates consecutive identical states",
    input: { queue: [statusEvent("busy"), statusEvent("busy")] },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["running"],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "abort emits stopped and suppresses later idle events",
    input: {
      endAfterDrain: false,
      queue: [],
      afterStart: async ({ monitor, state }) => {
        await monitor.execute({ ...openCodeMonitorActions.abort });
        state.queue.push(idleEvent());
      },
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["stopped"],
        actions: [],
        permissionCalls: [],
        aborted: true,
        abortCalls: 1,
      }),
    ],
  },
  {
    name: "approve with remember posts allow and remember to the permission endpoint",
    input: {
      queue: [],
      endAfterDrain: false,
      afterStart: async ({ monitor }) => {
        await monitor.execute({
          ...openCodeMonitorActions.approveRemember,
          metadata: { permissionID: "permission-9" },
        });
      },
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: [],
        actions: [],
        permissionCalls: [
          { sessionId: primarySessionId, permissionId: "permission-9", response: "allow", remember: true },
        ],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "reject posts deny without remember",
    input: {
      queue: [],
      endAfterDrain: false,
      afterStart: async ({ monitor }) => {
        await monitor.execute({ ...openCodeMonitorActions.reject, metadata: { permissionID: "permission-9" } });
      },
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: [],
        actions: [],
        permissionCalls: [
          { sessionId: primarySessionId, permissionId: "permission-9", response: "deny", remember: false },
        ],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "reconnects after a stream failure and reconciles a busy session without a terminal state",
    input: {
      streamFailures: 1,
      queue: [statusEvent("busy")],
      sessionStatus: "busy",
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["running"],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "reconciles a missing session as failed after a disconnect",
    input: {
      streamFailures: 1,
      queue: [],
      sessionExists: false,
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["failed"],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "keeps the current state when the reconnect status is unknown",
    input: {
      streamFailures: 1,
      queue: [],
      sessionExists: true,
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: [],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "does not mark a disconnected session as completed",
    input: {
      streamFailures: 2,
      queue: [statusEvent("busy")],
      sessionStatus: "idle",
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["running", "waiting_input"],
        actions: [],
        permissionCalls: [],
        aborted: false,
        abortCalls: 0,
      }),
    ],
  },
  {
    name: "stop aborts the open event stream so the process is not held alive",
    input: {
      endAfterDrain: false,
      queue: [],
    },
    assert: [hasObserved<MonitorContext, MonitorResult>("streamAborted", true)],
  },
] satisfies readonly OperationCase<"default", MonitorInput, MonitorResult, MonitorContext>[];

const table: OperationTable<FakeState, "default", MonitorInput, MonitorResult, MonitorContext> = {
  defaultFixture: () => ({ fixture: createFakeState() }),
  cases,
  execute: async (state, input) => {
    state.queue = [...input.queue];
    state.streamFailures = input.streamFailures ?? 0;
    state.sessionExists = input.sessionExists ?? true;
    state.sessionStatus = input.sessionStatus;
    state.endAfterDrain = input.endAfterDrain ?? true;
    const monitor = new OpenCodeMonitor({
      baseUrl: "http://127.0.0.1:4096",
      sessionId: input.sessionId ?? primarySessionId,
      workspaceRoot: input.workspaceRoot ?? "/workspace",
      client: createFakeClient(state),
      reconnectDelayMs: () => 1,
    });
    const observations: AgentObservation[] = [];
    await monitor.start((observation) => {
      observations.push(observation);
    });
    if (input.afterStart) await input.afterStart({ monitor, observations, state });
    await settle(state);
    await monitor.stop();
    return {
      states: observations
        .filter(
          (observation): observation is Extract<AgentObservation, { type: "state_changed" }> =>
            observation.type === "state_changed",
        )
        .map((observation) => observation.state),
      actions: observations
        .filter(
          (observation): observation is Extract<AgentObservation, { type: "action_requested" }> =>
            observation.type === "action_requested",
        )
        .map((observation) => ({ id: observation.action.id, metadata: observation.action.metadata })),
      permissionCalls: state.permissionCalls,
      aborted: state.aborted,
      abortCalls: state.abortCalls,
    };
  },
  observe: (state, _result) => ({
    streamSignals: state.streamSignals,
    streamAborted: state.streamAborted,
  }),
};

describe("opencode monitor", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

function createFakeState(): FakeState {
  return {
    queue: [],
    streamFailures: 0,
    sessionExists: true,
    sessionStatus: undefined,
    endAfterDrain: true,
    generatorEnded: false,
    started: false,
    drainedIndex: 0,
    aborted: false,
    streamSignals: 0,
    streamAborted: false,
    permissionCalls: [],
    abortCalls: 0,
  };
}

function createFakeClient(state: FakeState): OpenCodeMonitorClient {
  return {
    async *events(signal?: AbortSignal) {
      state.started = true;
      if (signal) {
        state.streamSignals += 1;
        signal.addEventListener("abort", () => {
          state.streamAborted = true;
        });
      }
      if (state.streamFailures > 0) {
        state.streamFailures -= 1;
        throw new OpenCodeStreamClosedError("test stream failure");
      }
      let index = state.drainedIndex;
      for (;;) {
        while (index < state.queue.length) {
          state.drainedIndex = index + 1;
          yield state.queue[index];
          index += 1;
        }
        if (state.endAfterDrain) {
          state.generatorEnded = true;
          throw new OpenCodeStreamClosedError("test stream ended");
        }
        await sleep(1);
      }
    },
    async sessionExists() {
      return state.sessionExists;
    },
    async sessionStatus() {
      return state.sessionStatus;
    },
    async abortSession() {
      state.abortCalls += 1;
      state.aborted = true;
      return true;
    },
    async replyPermission(sessionId: string, permissionId: string, response: "allow" | "deny", remember: boolean) {
      state.permissionCalls.push({ sessionId, permissionId, response, remember });
      return true;
    },
    async forkSession() {
      return "forked-session";
    },
  };
}

async function settle(state: FakeState): Promise<void> {
  const deadline = Date.now() + 1_000;
  for (;;) {
    if (state.endAfterDrain && state.generatorEnded) {
      await sleep(10);
      return;
    }
    if (!state.endAfterDrain && state.started) {
      await sleep(10);
      return;
    }
    if (Date.now() >= deadline) return;
    await sleep(5);
  }
}

function statusEvent(type: "busy" | "idle" | "retry"): OpenCodeEvent {
  return { type: "session.status", properties: { sessionID: primarySessionId, status: { type } } };
}

function idleEvent(): OpenCodeEvent {
  return { type: "session.idle", properties: { sessionID: primarySessionId } };
}

function permissionEvent(permissionId: string, title: string): OpenCodeEvent {
  return {
    type: "permission.updated",
    properties: {
      id: permissionId,
      sessionID: primarySessionId,
      messageID: "message-1",
      title,
      type: "bash",
      pattern: "npm run *",
    },
  };
}

function replyEvent(permissionId: string): OpenCodeEvent {
  return {
    type: "permission.replied",
    properties: { sessionID: primarySessionId, permissionID: permissionId, response: "allow" },
  };
}

function errorEvent(sessionID: string | undefined, name: string): OpenCodeEvent {
  return {
    type: "session.error",
    properties: {
      ...(sessionID ? { sessionID } : {}),
      error: { name, data: { message: "provider failed" } },
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
