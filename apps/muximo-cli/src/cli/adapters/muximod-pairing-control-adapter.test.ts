import { PassThrough } from "node:stream";
import type { AgentExecutionResult } from "@muximo/application";
import {
  encodeMuximodControlResponse,
  type MuximodControlRequest,
  type MuximodControlResponse,
} from "@muximo/contract/control";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import {
  MuximodPairingControlAdapter,
  type MuximodPairingControlAdapterOptions,
} from "./muximod-pairing-control-adapter.js";

type AdapterFixtureKey = "success" | "failure";
type AdapterFixture = {
  adapter: MuximodPairingControlAdapter;
  transport: PassThrough;
  writes: MuximodControlRequest[];
  executionRequests: string[];
  executionFinished: Promise<void>;
  push(response: MuximodControlResponse): void;
};
type AdapterContext = {
  executionRequests: readonly string[];
  completionResult: { code: number; diagnostic?: string } | undefined;
  released: boolean;
};
type AdapterInput = Record<string, never>;

const executionId = "execution-id-123456";
const token = "a".repeat(43);

const cases = [
  {
    name: "dispatches a daemon execution request while no control request is pending",
    fixture: "success",
    input: {},
    assert: [
      hasObserved<AdapterContext, undefined>("executionRequests", [executionId]),
      hasObserved<AdapterContext, undefined>("completionResult", { code: 0 }),
      hasObserved<AdapterContext, undefined>("released", true),
    ],
  },
  {
    name: "returns an execution failure to the daemon when the host handler throws",
    fixture: "failure",
    input: {},
    assert: [
      hasObserved<AdapterContext, undefined>("executionRequests", [executionId]),
      hasObserved<AdapterContext, undefined>("completionResult", {
        code: 127,
        diagnostic: "provider failed --token=[REDACTED]",
      }),
      hasObserved<AdapterContext, undefined>("released", true),
    ],
  },
] satisfies readonly OperationCase<AdapterFixtureKey, AdapterInput, undefined, AdapterContext>[];

const table: OperationTable<AdapterFixture, AdapterFixtureKey, AdapterInput, undefined, AdapterContext> = {
  defaultFixture: () => createFixture("success"),
  fixtures: {
    success: () => createFixture("success"),
    failure: () => createFixture("failure"),
  },
  cases,
  execute: async (fixture) => {
    const reservationPromise = fixture.adapter.reserveAgentExecution({ operation: "run", ownerPid: process.pid });
    const reservationRequest = await waitForRequest(fixture, "reserve_agent_execution");
    fixture.push({
      type: "agent_execution_reserved",
      requestId: reservationRequest.requestId,
      token,
      ownerPid: process.pid,
    });
    await reservationPromise;

    fixture.push({
      type: "execute_agent_process",
      requestId: "execution-request-123456",
      token,
      executionId,
      sessionId: "session-id",
      sessionName: "review",
      backend: "codex",
      cwd: "/workspace/review",
      command: ["codex"],
      environment: {},
    });
    await fixture.executionFinished;

    const completionRequest = await waitForRequest(fixture, "complete_agent_execution");
    fixture.push({
      type: "agent_execution_completed",
      requestId: completionRequest.requestId,
      executionRequestId: "execution-request-123456",
      token,
      executionId,
    });

    const releasePromise = fixture.adapter.releaseAgentExecution(token);
    const releaseRequest = await waitForRequest(fixture, "release_agent_execution");
    fixture.push({
      type: "agent_execution_released",
      requestId: releaseRequest.requestId,
      token,
    });
    await releasePromise;
    return undefined;
  },
  observe: (fixture) => {
    const completion = fixture.writes.find(
      (request): request is Extract<MuximodControlRequest, { type: "complete_agent_execution" }> =>
        request.type === "complete_agent_execution",
    );
    return {
      executionRequests: [...fixture.executionRequests],
      completionResult:
        completion === undefined
          ? undefined
          : {
              code: completion.result.code,
              ...(completion.result.failureDiagnostic === undefined
                ? {}
                : { diagnostic: completion.result.failureDiagnostic }),
            },
      released: fixture.writes.some((request) => request.type === "release_agent_execution"),
    };
  },
};

describe("muximod pairing control adapter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

type ConcurrentFixture = {
  adapter: MuximodPairingControlAdapter;
  transport: PassThrough;
  executionRequests: string[];
  state: { closed: boolean };
  closed: Promise<void>;
  push(response: MuximodControlResponse): void;
};
type ConcurrentContext = {
  executionRequests: readonly string[];
  closed: boolean;
};

const concurrentCases = [
  {
    name: "closes the control connection when the daemon sends concurrent executions",
    input: {},
    assert: [
      hasObserved<ConcurrentContext, undefined>("executionRequests", [executionId]),
      hasObserved<ConcurrentContext, undefined>("closed", true),
    ],
  },
] satisfies readonly OperationCase<"default", Record<string, never>, undefined, ConcurrentContext>[];

const concurrentTable: OperationTable<
  ConcurrentFixture,
  "default",
  Record<string, never>,
  undefined,
  ConcurrentContext
> = {
  defaultFixture: createConcurrentFixture,
  cases: concurrentCases,
  execute: async (fixture) => {
    fixture.push(executionFrame("execution-request-1"));
    await waitForCondition(() => fixture.executionRequests.length === 1);
    fixture.push(executionFrame("execution-request-2"));
    await fixture.closed;
    return undefined;
  },
  observe: (fixture) => ({
    executionRequests: [...fixture.executionRequests],
    closed: fixture.state.closed,
  }),
};

describe("muximod pairing control adapter protocol guards", () => {
  runOperationTable(it as unknown as TestRegistrar, concurrentTable);
});

function createFixture(mode: AdapterFixtureKey): FixtureHandle<AdapterFixture> {
  const transport = new PassThrough();
  const writes: MuximodControlRequest[] = [];
  const executionRequests: string[] = [];
  let finishExecution!: () => void;
  const executionFinished = new Promise<void>((resolve) => {
    finishExecution = resolve;
  });
  const options: MuximodPairingControlAdapterOptions = {
    onAgentExecution: async (request) => {
      executionRequests.push(request.executionId);
      try {
        if (mode === "failure") throw new Error("provider failed --token=secret");
        return { started: true, code: 0, interrupted: false, signal: null, pid: 456 } satisfies AgentExecutionResult;
      } finally {
        finishExecution();
      }
    },
  };
  const originalWrite = transport.write.bind(transport);
  transport.write = ((chunk: string | Uint8Array) => {
    writes.push(JSON.parse(chunk.toString()) as MuximodControlRequest);
    return true;
  }) as typeof transport.write;
  const Adapter = MuximodPairingControlAdapter as unknown as {
    new (
      socket: import("node:net").Socket,
      options?: MuximodPairingControlAdapterOptions,
    ): MuximodPairingControlAdapter;
  };
  const adapter = new Adapter(transport as unknown as import("node:net").Socket, options);
  const fixture: AdapterFixture = {
    adapter,
    transport,
    writes,
    executionRequests,
    executionFinished,
    push(response: MuximodControlResponse) {
      transport.push(`${encodeMuximodControlResponse(response)}\n`);
    },
  };
  return {
    fixture,
    cleanup: () => {
      adapter.close();
      transport.write = originalWrite;
    },
  };
}

async function waitForRequest<Kind extends MuximodControlRequest["type"]>(
  fixture: AdapterFixture,
  type: Kind,
): Promise<Extract<MuximodControlRequest, { type: Kind }>> {
  const deadline = Date.now() + 2_000;
  while (true) {
    const request = fixture.writes.find((candidate) => candidate.type === type);
    if (request) return request as Extract<MuximodControlRequest, { type: Kind }>;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${type} request`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitForCondition(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function createConcurrentFixture(): FixtureHandle<ConcurrentFixture> {
  const transport = new PassThrough();
  const executionRequests: string[] = [];
  const state = { closed: false };
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  transport.once("close", () => {
    state.closed = true;
    resolveClosed();
  });
  const originalWrite = transport.write.bind(transport);
  transport.write = (() => true) as typeof transport.write;
  const options: MuximodPairingControlAdapterOptions = {
    onAgentExecution: async (request) => {
      executionRequests.push(request.executionId);
      return { started: true, code: 0, interrupted: false, signal: null, pid: 456 } satisfies AgentExecutionResult;
    },
  };
  const Adapter = MuximodPairingControlAdapter as unknown as {
    new (
      socket: import("node:net").Socket,
      options?: MuximodPairingControlAdapterOptions,
    ): MuximodPairingControlAdapter;
  };
  const adapter = new Adapter(transport as unknown as import("node:net").Socket, options);
  return {
    fixture: {
      adapter,
      transport,
      executionRequests,
      state,
      closed,
      push(response: MuximodControlResponse) {
        transport.push(`${encodeMuximodControlResponse(response)}\n`);
      },
    },
    cleanup: () => {
      adapter.close();
      transport.write = originalWrite;
    },
  };
}

function executionFrame(requestId: string): Extract<MuximodControlResponse, { type: "execute_agent_process" }> {
  return {
    type: "execute_agent_process",
    requestId,
    token,
    executionId,
    sessionId: "session-id",
    sessionName: "review",
    backend: "codex",
    cwd: "/workspace/review",
    command: ["codex"],
    environment: {},
  };
}
