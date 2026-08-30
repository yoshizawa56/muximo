import type { AgentExecutionRequest } from "@muximo/application";
import type { MuximodControlResponse } from "@muximo/contract/control";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { AgentExecutionBroker, type AgentExecutionControlPeer } from "./agent-execution.js";

type BrokerInput = {
  action: "success" | "operation-mismatch" | "pane-mismatch" | "connection-close";
};
type BrokerFixture = {
  broker: AgentExecutionBroker;
  peer: AgentExecutionControlPeer;
  frames: MuximodControlResponse[];
  resultCode?: number;
  resultPid?: number;
  pendingError?: string;
  secondUseError?: string;
};
type BrokerContext = {
  frames: readonly string[];
  resultCode: number | undefined;
  resultPid: number | undefined;
  pendingError: string | undefined;
  secondUseError: string | undefined;
};

const request: AgentExecutionRequest = {
  sessionId: "agent-session-id",
  executionId: "execution-id-123456",
  sessionName: "review",
  backend: "codex",
  command: ["codex", "--opaque"],
  cwd: "/workspace/review",
  environment: { MUXIMO_AGENT_SESSION_ID: "agent-session-id" },
};

const cases = [
  {
    name: "dispatches the prepared command and resolves its completion",
    input: { action: "success" },
    assert: [
      hasObserved<BrokerContext, undefined>("frames", ["execute_agent_process:execution-id-123456"]),
      hasObserved<BrokerContext, undefined>("resultCode", 0),
      hasObserved<BrokerContext, undefined>("resultPid", 456),
      hasObserved<BrokerContext, undefined>("secondUseError", "agent execution capability has already been used"),
    ],
  },
  {
    name: "rejects a token used for a different operation",
    input: { action: "operation-mismatch" },
    assert: [
      hasError<BrokerContext, undefined>({ message: "agent execution token does not match the requested operation" }),
    ],
  },
  {
    name: "rejects a token used for a different pane",
    input: { action: "pane-mismatch" },
    assert: [
      hasError<BrokerContext, undefined>({ message: "agent execution token does not match the requested pane" }),
    ],
  },
  {
    name: "rejects a pending execution when its control connection closes",
    input: { action: "connection-close" },
    assert: [
      hasObserved<BrokerContext, undefined>("frames", ["execute_agent_process:execution-id-123456"]),
      hasObserved<BrokerContext, undefined>("pendingError", "agent execution control connection closed"),
    ],
  },
] satisfies readonly OperationCase<"default", BrokerInput, undefined, BrokerContext>[];

const table: OperationTable<BrokerFixture, "default", BrokerInput, undefined, BrokerContext> = {
  defaultFixture: createFixture,
  cases,
  execute: async (fixture, input) => {
    const reservation = fixture.broker.reserve(fixture.peer, {
      operation: "run",
      hostPaneId: "%1",
      ownerPid: 321,
    });

    if (input.action === "operation-mismatch") {
      await fixture.broker.consume({ token: reservation.token, operation: "resume", hostPaneId: "%1" });
    }
    if (input.action === "pane-mismatch") {
      await fixture.broker.consume({ token: reservation.token, operation: "run", hostPaneId: "%2" });
    }
    if (input.action === "success" || input.action === "connection-close") {
      const execution = await fixture.broker.consume({ token: reservation.token, operation: "run", hostPaneId: "%1" });
      const pending = execution.execute(request);
      await waitFor(() => fixture.frames.length === 1);
      const frame = fixture.frames[0];
      if (frame?.type !== "execute_agent_process") throw new Error("agent execution request was not sent");
      if (input.action === "connection-close") {
        fixture.broker.close(fixture.peer);
        try {
          await pending;
        } catch (error) {
          fixture.pendingError = error instanceof Error ? error.message : String(error);
        }
      } else {
        fixture.broker.complete(fixture.peer, {
          type: "complete_agent_execution",
          requestId: "completion-request",
          executionRequestId: frame.requestId,
          token: reservation.token,
          executionId: request.executionId,
          result: { started: true, code: 0, interrupted: false, signal: null, pid: 456 },
        });
        const result = await pending;
        fixture.resultCode = result.code;
        fixture.resultPid = result.pid;
        try {
          await execution.execute(request);
        } catch (error) {
          fixture.secondUseError = error instanceof Error ? error.message : String(error);
        }
      }
    }
    return undefined;
  },
  observe: (fixture) => ({
    frames: fixture.frames.map((frame) =>
      frame.type === "execute_agent_process" ? `${frame.type}:${frame.executionId}` : frame.type,
    ),
    resultCode: fixture.resultCode,
    resultPid: fixture.resultPid,
    pendingError: fixture.pendingError,
    secondUseError: fixture.secondUseError,
  }),
};

function createFixture(): { fixture: BrokerFixture } {
  const frames: MuximodControlResponse[] = [];
  const peer: AgentExecutionControlPeer = {
    isOpen: () => true,
    send: (frame) => frames.push(frame),
  };
  return {
    fixture: {
      broker: new AgentExecutionBroker(),
      peer,
      frames,
    },
  };
}

describe("agent execution broker", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for agent execution request");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
