import { authRateWindowMs } from "@muximo/application";
import {
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { type MuximodSocket, type MuximodSocketData, muximodSocketReadyState } from "../http/socket.js";
import {
  type AuthFlowSweepScheduler,
  MemoryAuthChallengeStore,
  MemoryAuthenticatedConnectionRegistry,
  MemoryAuthFlowLifecycle,
  MemoryAuthRateLimitStore,
  MemoryAuthWsTicketStore,
} from "./flow-store-memory.js";

type FlowStep = { type: "start" } | { type: "sweep" } | { type: "stop" } | { type: "invalid-interval"; value: number };
type FlowFixture = {
  challenges: MemoryAuthChallengeStore;
  rateLimits: MemoryAuthRateLimitStore;
  wsTickets: MemoryAuthWsTicketStore;
  lifecycle: MemoryAuthFlowLifecycle;
  scheduled: number;
  cleared: number;
  invalidIntervalError?: string;
  callbacks: Array<() => void>;
};
type FlowContext = {
  challengeCount: number;
  rateLimitCount: number;
  ticketCount: number;
  scheduled: number;
  cleared: number;
  invalidIntervalError?: string;
};

const now = new Date("2099-08-15T00:00:00.000Z");
const expired = "2099-08-14T23:59:00.000Z";
const future = "2099-08-15T00:01:00.000Z";

const flowFixture = (): FixtureHandle<FlowFixture> => {
  const challenges = new MemoryAuthChallengeStore();
  const rateLimits = new MemoryAuthRateLimitStore();
  const wsTickets = new MemoryAuthWsTicketStore();
  const callbacks: Array<() => void> = [];
  let scheduled = 0;
  let cleared = 0;
  const scheduler: AuthFlowSweepScheduler = {
    setInterval: (callback) => {
      callbacks.push(callback);
      scheduled += 1;
      return callbacks.length;
    },
    clearInterval: () => {
      cleared += 1;
    },
  };
  challenges.put({ challengeId: "expired-challenge", deviceId: "device", nonce: "nonce", expiresAt: expired });
  challenges.put({ challengeId: "future-challenge", deviceId: "device", nonce: "nonce", expiresAt: future });
  rateLimits.setWindow("expired-device", { startedAt: now.getTime() - authRateWindowMs - 1, count: 1 });
  rateLimits.setWindow("future-device", { startedAt: now.getTime() - 1, count: 1 });
  wsTickets.put("expired-ticket", { sessionId: "session", endpoint: "terminal", expiresAt: expired });
  wsTickets.put("future-ticket", { sessionId: "session", endpoint: "terminal", expiresAt: future });
  const lifecycle = new MemoryAuthFlowLifecycle({
    challenges,
    rateLimits,
    wsTickets,
    clock: { now: () => now },
    intervalMs: 1_000,
    scheduler,
  });
  return {
    fixture: {
      challenges,
      rateLimits,
      wsTickets,
      lifecycle,
      callbacks,
      get scheduled() {
        return scheduled;
      },
      get cleared() {
        return cleared;
      },
    },
    cleanup: () => lifecycle.stop(),
  };
};

const cases = [
  {
    name: "sweeps expired flow state and stops its composition timer",
    steps: [{ type: "start" }, { type: "sweep" }, { type: "stop" }],
    assert: [
      hasObserved<FlowContext, undefined>("challengeCount", 1),
      hasObserved<FlowContext, undefined>("rateLimitCount", 1),
      hasObserved<FlowContext, undefined>("ticketCount", 1),
      hasObserved<FlowContext, undefined>("scheduled", 1),
      hasObserved<FlowContext, undefined>("cleared", 1),
    ],
  },
  {
    name: "starts and stops idempotently without leaking timers",
    steps: [
      { type: "start" },
      { type: "start" },
      { type: "stop" },
      { type: "stop" },
      { type: "start" },
      { type: "stop" },
    ],
    assert: [
      hasObserved<FlowContext, undefined>("challengeCount", 2),
      hasObserved<FlowContext, undefined>("rateLimitCount", 2),
      hasObserved<FlowContext, undefined>("ticketCount", 2),
      hasObserved<FlowContext, undefined>("scheduled", 2),
      hasObserved<FlowContext, undefined>("cleared", 2),
    ],
  },
  {
    name: "rejects a non-positive sweep interval",
    steps: [{ type: "invalid-interval", value: 0 }],
    assert: [
      hasObserved<FlowContext, undefined>(
        "invalidIntervalError",
        "auth flow sweep interval must be a positive integer",
      ),
    ],
  },
] satisfies readonly ScenarioCase<"default", FlowStep, undefined, FlowContext>[];

const table: ScenarioTable<FlowFixture, "default", FlowStep, undefined, FlowContext> = {
  defaultFixture: flowFixture,
  cases,
  execute: (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "start") fixture.lifecycle.start();
      else if (step.type === "sweep") fixture.lifecycle.sweep();
      else if (step.type === "stop") fixture.lifecycle.stop();
      else {
        try {
          new MemoryAuthFlowLifecycle({
            challenges: fixture.challenges,
            rateLimits: fixture.rateLimits,
            wsTickets: fixture.wsTickets,
            clock: { now: () => now },
            intervalMs: step.value,
          });
        } catch (error) {
          fixture.invalidIntervalError = error instanceof Error ? error.message : String(error);
        }
      }
    }
  },
  observe: (fixture) => ({
    challengeCount: fixture.challenges.size(),
    rateLimitCount: fixture.rateLimits.size(),
    ticketCount: fixture.wsTickets.size(),
    scheduled: fixture.scheduled,
    cleared: fixture.cleared,
    invalidIntervalError: fixture.invalidIntervalError,
  }),
};

describe("memory authentication flow lifecycle", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

type ConnectionKey = "first" | "second";
type ConnectionFixtureKey = "connecting" | "closing" | "closed";
type ConnectionStep =
  | { type: "register"; connection: ConnectionKey; sessionId: string; deviceId: string }
  | { type: "expire"; connection: ConnectionKey }
  | { type: "disconnect-device"; deviceId: string }
  | { type: "disconnect-session"; sessionId: string }
  | { type: "network-close"; connection: ConnectionKey };
type CloseCall = { code: number | undefined; reason: string | undefined };
type ConnectionFixture = {
  registry: MemoryAuthenticatedConnectionRegistry;
  sockets: Record<ConnectionKey, FakeAuthenticatedSocket>;
  callbacks: Array<() => void>;
  timerIds: Partial<Record<ConnectionKey, number>>;
  cleared: number;
};
type ConnectionContext = {
  firstCloseCalls: readonly CloseCall[];
  secondCloseCalls: readonly CloseCall[];
  firstCloseListenerCount: number;
  firstCloseListenerRegistrations: number;
  registrySize: number;
  scheduled: number;
  cleared: number;
};

const createConnectionFixture = (readyState: number): FixtureHandle<ConnectionFixture> => {
  const callbacks: Array<() => void> = [];
  let cleared = 0;
  const registry = new MemoryAuthenticatedConnectionRegistry({
    now: () => now.getTime(),
    scheduler: {
      setTimeout: (callback) => {
        callbacks.push(callback);
        return callbacks.length - 1;
      },
      clearTimeout: () => {
        cleared += 1;
      },
    },
  });
  return {
    fixture: {
      registry,
      sockets: {
        first: new FakeAuthenticatedSocket(readyState),
        second: new FakeAuthenticatedSocket(readyState),
      },
      callbacks,
      timerIds: {},
      get cleared() {
        return cleared;
      },
    },
    cleanup: () => undefined,
  };
};

const connectionFixture = (): FixtureHandle<ConnectionFixture> => createConnectionFixture(muximodSocketReadyState.open);

const connectionCases = [
  {
    name: "disconnects an expired session exactly once",
    steps: [
      { type: "register", connection: "first", sessionId: "session-1", deviceId: "device-1" },
      { type: "expire", connection: "first" },
      { type: "disconnect-device", deviceId: "device-1" },
    ],
    assert: [
      hasObserved<ConnectionContext, undefined>("firstCloseCalls", [{ code: 4001, reason: "session expired" }]),
      hasObserved<ConnectionContext, undefined>("registrySize", 0),
    ],
  },
  {
    name: "disconnects every active session for a revoked device exactly once",
    steps: [
      { type: "register", connection: "first", sessionId: "session-1", deviceId: "device-1" },
      { type: "register", connection: "second", sessionId: "session-2", deviceId: "device-1" },
      { type: "disconnect-device", deviceId: "device-1" },
      { type: "disconnect-device", deviceId: "device-1" },
    ],
    assert: [
      hasObserved<ConnectionContext, undefined>("firstCloseCalls", [{ code: 4001, reason: "device revoked" }]),
      hasObserved<ConnectionContext, undefined>("secondCloseCalls", [{ code: 4001, reason: "device revoked" }]),
      hasObserved<ConnectionContext, undefined>("registrySize", 0),
    ],
  },
  {
    name: "disconnects only the requested session and cleans up network closes",
    steps: [
      { type: "register", connection: "first", sessionId: "session-1", deviceId: "device-1" },
      { type: "register", connection: "second", sessionId: "session-2", deviceId: "device-2" },
      { type: "disconnect-session", sessionId: "session-1" },
      { type: "network-close", connection: "second" },
      { type: "disconnect-session", sessionId: "session-2" },
    ],
    assert: [
      hasObserved<ConnectionContext, undefined>("firstCloseCalls", [{ code: 4001, reason: "session revoked" }]),
      hasObserved<ConnectionContext, undefined>("secondCloseCalls", []),
      hasObserved<ConnectionContext, undefined>("registrySize", 0),
    ],
  },
  {
    name: "retains a connecting socket after installing its close listener",
    fixture: "connecting",
    steps: [{ type: "register", connection: "first", sessionId: "session-1", deviceId: "device-1" }],
    assert: [
      hasObserved<ConnectionContext, undefined>("registrySize", 1),
      hasObserved<ConnectionContext, undefined>("scheduled", 1),
      hasObserved<ConnectionContext, undefined>("firstCloseListenerCount", 1),
      hasObserved<ConnectionContext, undefined>("firstCloseListenerRegistrations", 1),
    ],
  },
  {
    name: "does not retain a socket already closing at registration",
    fixture: "closing",
    steps: [{ type: "register", connection: "first", sessionId: "session-1", deviceId: "device-1" }],
    assert: [
      hasObserved<ConnectionContext, undefined>("firstCloseCalls", []),
      hasObserved<ConnectionContext, undefined>("registrySize", 0),
      hasObserved<ConnectionContext, undefined>("scheduled", 0),
      hasObserved<ConnectionContext, undefined>("firstCloseListenerCount", 0),
      hasObserved<ConnectionContext, undefined>("firstCloseListenerRegistrations", 1),
    ],
  },
  {
    name: "does not retain a socket already closed at registration",
    fixture: "closed",
    steps: [{ type: "register", connection: "first", sessionId: "session-1", deviceId: "device-1" }],
    assert: [
      hasObserved<ConnectionContext, undefined>("firstCloseCalls", []),
      hasObserved<ConnectionContext, undefined>("registrySize", 0),
      hasObserved<ConnectionContext, undefined>("scheduled", 0),
      hasObserved<ConnectionContext, undefined>("firstCloseListenerCount", 0),
      hasObserved<ConnectionContext, undefined>("firstCloseListenerRegistrations", 1),
    ],
  },
] satisfies readonly ScenarioCase<ConnectionFixtureKey, ConnectionStep, undefined, ConnectionContext>[];

const connectionTable: ScenarioTable<
  ConnectionFixture,
  ConnectionFixtureKey,
  ConnectionStep,
  undefined,
  ConnectionContext
> = {
  defaultFixture: connectionFixture,
  fixtures: {
    connecting: () => createConnectionFixture(muximodSocketReadyState.connecting),
    closing: () => createConnectionFixture(muximodSocketReadyState.closing),
    closed: () => createConnectionFixture(muximodSocketReadyState.closed),
  },
  cases: connectionCases,
  execute: async (fixture, steps) => {
    for (const step of steps) {
      if (step.type === "register") {
        const scheduledBefore = fixture.callbacks.length;
        fixture.registry.register({
          sessionId: step.sessionId,
          deviceId: step.deviceId,
          expiresAt: future,
          socket: fixture.sockets[step.connection],
        });
        if (fixture.callbacks.length > scheduledBefore) {
          fixture.timerIds[step.connection] = fixture.callbacks.length - 1;
        }
      } else if (step.type === "expire") {
        const timerId = fixture.timerIds[step.connection];
        if (timerId === undefined) throw new Error(`no timer registered for ${step.connection}`);
        fixture.callbacks[timerId]?.();
      } else if (step.type === "disconnect-device") {
        await fixture.registry.disconnectDevice(step.deviceId);
      } else if (step.type === "disconnect-session") {
        await fixture.registry.disconnectSession(step.sessionId);
      } else {
        fixture.sockets[step.connection].networkClose();
      }
    }
  },
  observe: (fixture) => ({
    firstCloseCalls: [...fixture.sockets.first.closeCalls],
    secondCloseCalls: [...fixture.sockets.second.closeCalls],
    firstCloseListenerCount: fixture.sockets.first.closeListenerCount,
    firstCloseListenerRegistrations: fixture.sockets.first.closeListenerRegistrations,
    registrySize: fixture.registry.size,
    scheduled: fixture.callbacks.length,
    cleared: fixture.cleared,
  }),
};

describe("memory authenticated connection registry", () => {
  runScenarioTable(it as unknown as TestRegistrar, connectionTable);
});

class FakeAuthenticatedSocket implements MuximodSocket {
  public readonly closeCalls: CloseCall[] = [];
  public closeListenerRegistrations = 0;
  private readonly closeListeners = new Set<() => void>();

  public constructor(public readyState: number) {}

  public get closeListenerCount(): number {
    return this.closeListeners.size;
  }

  public send(_data: MuximodSocketData): number | undefined {
    return undefined;
  }

  public close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    this.readyState = muximodSocketReadyState.closed;
    for (const listener of [...this.closeListeners]) listener();
  }

  public onMessage(_listener: (data: MuximodSocketData, isBinary: boolean) => void): () => void {
    return () => undefined;
  }

  public onClose(listener: () => void): () => void {
    this.closeListenerRegistrations += 1;
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  public onError(_listener: (error: Error) => void): () => void {
    return () => undefined;
  }

  public networkClose(): void {
    this.readyState = muximodSocketReadyState.closed;
    for (const listener of [...this.closeListeners]) listener();
  }
}
