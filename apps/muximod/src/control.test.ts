import { AuthService } from "@muximo/application";
import {
  AuthStore,
  createAgentDatabase,
  MemoryAuthChallengeStore,
  MemoryAuthRateLimitStore,
  MemoryAuthWsTicketStore,
  MemoryTrackedSocketRegistry,
  nodeAuthCrypto,
} from "@muximo/infrastructure";
import {
  type FixtureHandle,
  hasObserved,
  runScenarioTable,
  type ScenarioCase,
  type ScenarioTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { MuximodControlServer } from "./control.js";

type ControlRequest = { agentSessionId: string; tmuxPaneId: string; executionId: string };
type ControlStep = { type: "adopt" | "observe" | "release" };
type ControlFixture = {
  server: MuximodControlServer;
  handleRequest: (line: string) => void;
  request: ControlRequest;
  responses: string[];
  calls: string[];
  observations: string[];
  socket: { destroyed: boolean; write(data: string): void };
  database: ReturnType<typeof createAgentDatabase>;
};
type ControlContext = { responses: readonly unknown[]; calls: readonly string[]; observations: readonly string[] };

const request: ControlRequest = { agentSessionId: "session-id", tmuxPaneId: "%1", executionId: "execution-id-123456" };

const fixture = (): FixtureHandle<ControlFixture> => {
  const database = createAgentDatabase();
  const auth = new AuthService({
    store: new AuthStore(database.db, database.sqlite),
    crypto: nodeAuthCrypto,
    muximodBaseUrl: "http://127.0.0.1:4317",
    challenges: new MemoryAuthChallengeStore(),
    rateLimits: new MemoryAuthRateLimitStore(),
    wsTickets: new MemoryAuthWsTicketStore(),
    sockets: new MemoryTrackedSocketRegistry(),
  });
  const calls: string[] = [];
  const observations: string[] = [];
  const responses: string[] = [];
  const server = new MuximodControlServer({
    socketPath: "/tmp/muximod-control-test.sock",
    auth,
    adoptAgentSession: async (input) => {
      calls.push(`adopt:${input.agentSessionId}:${input.tmuxPaneId}:${input.executionId}`);
    },
    observeAgentSession: async (input) => {
      observations.push(
        `${input.agentSessionId}:${input.tmuxPaneId}:${input.executionId}:${input.state}:${input.recentOutput ?? ""}`,
      );
    },
    releaseAgentSession: async (input) => {
      calls.push(`release:${input.agentSessionId}:${input.tmuxPaneId}:${input.executionId}`);
    },
  });
  const socket = {
    destroyed: false,
    write(data: string) {
      responses.push(data);
    },
  };
  const handleRequest = (
    server as unknown as {
      handleRequest: (client: typeof socket, line: string) => void;
    }
  ).handleRequest.bind(server);
  return {
    fixture: {
      server,
      handleRequest: (line) => handleRequest(socket, line),
      request,
      responses,
      calls,
      observations,
      socket,
      database,
    },
    cleanup: () => {
      server.stop();
      database.close();
    },
  };
};

const cases = [
  {
    name: "dispatches pane adoption and release requests to the daemon",
    steps: [{ type: "adopt" }, { type: "observe" }, { type: "release" }],
    assert: [
      hasObserved<ControlContext, undefined>("responses", [
        { type: "agent_session_adopted", ...request },
        { type: "agent_session_observed", ...request, state: "waiting_input" },
        { type: "agent_session_released", ...request },
      ]),
      hasObserved<ControlContext, undefined>("calls", [
        "adopt:session-id:%1:execution-id-123456",
        "release:session-id:%1:execution-id-123456",
      ]),
      hasObserved<ControlContext, undefined>("observations", [
        "session-id:%1:execution-id-123456:waiting_input:recent output",
      ]),
    ],
  },
] satisfies readonly ScenarioCase<"default", ControlStep, undefined, ControlContext>[];

const table: ScenarioTable<ControlFixture, "default", ControlStep, undefined, ControlContext> = {
  defaultFixture: fixture,
  cases,
  execute: async (testFixture, steps) => {
    for (const step of steps) {
      const type =
        step.type === "adopt"
          ? "adopt_agent_session"
          : step.type === "observe"
            ? "observe_agent_session"
            : "release_agent_session";
      const expectedCount = testFixture.responses.length + 1;
      testFixture.handleRequest(
        JSON.stringify({
          type,
          ...testFixture.request,
          ...(step.type === "observe" ? { state: "waiting_input", recentOutput: "recent output" } : {}),
        }),
      );
      await waitFor(() => testFixture.responses.length === expectedCount);
    }
  },
  observe: (testFixture) => ({
    responses: testFixture.responses.map((value) => JSON.parse(value)),
    calls: [...testFixture.calls],
    observations: [...testFixture.observations],
  }),
};

describe("muximod private control socket", () => {
  runScenarioTable(it as unknown as TestRegistrar, table);
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for muximod control response");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}
