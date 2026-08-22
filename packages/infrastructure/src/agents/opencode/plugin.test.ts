import {
  hasError,
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { AgentMonitor, AgentObservationSink, AgentPluginV1 } from "../index.js";
import type { OpenCodeClient, OpenCodeSessionStatus } from "./client.js";
import type { OpenCodeMonitorOptions } from "./monitor.js";
import { createOpenCodePlugin } from "./plugin.js";
import type { OpenCodeServerEntry, OpenCodeServerManager } from "./server.js";

const serverEntry: OpenCodeServerEntry = {
  workspaceRoot: "/workspace",
  pid: 7_000,
  port: 49_152,
  version: "1.2.3",
  startedAt: "2026-08-15T00:00:00.000Z",
};

function fakeManager(
  overrides: { ensureThrows?: boolean; sessions?: Record<string, unknown> } = {},
): OpenCodeServerManager {
  return {
    ensure: async (root: string) => {
      if (overrides.ensureThrows) throw new Error("opencode serve did not become healthy within 15000ms");
      return { ...serverEntry, workspaceRoot: root };
    },
    isHealthy: async () => true,
    dispose: async () => true,
    disposeAll: async () => undefined,
    list: () => [serverEntry],
  } as unknown as OpenCodeServerManager;
}

type ClientRecords = {
  createdTitles: (string | undefined)[];
  renamedSessions: { sessionId: string; title: string }[];
};

function fakeClient(records: ClientRecords, sessions: Record<string, unknown> = {}): OpenCodeClient {
  return {
    createSession: async (title?: string) => {
      records.createdTitles.push(title);
      return "session-created";
    },
    sessionExists: async (sessionId: string) => Object.hasOwn(sessions, sessionId),
    sessionStatus: async () => "idle" as OpenCodeSessionStatus,
    abortSession: async () => true,
    replyPermission: async () => true,
    forkSession: async () => "session-forked",
    setSessionTitle: async (sessionId: string, title: string) => {
      records.renamedSessions.push({ sessionId, title });
      return true;
    },
    events: async function* () {
      yield* [];
    },
  } as unknown as OpenCodeClient;
}

type EmptyContext = {};

type PluginInput = {
  kind: "detect" | "prepare" | "prepare-resume" | "prepare-resume-missing" | "launch";
  command?: string;
  name?: string;
};

type PluginResult = {
  detected: { agentId: string; confidence: number } | null;
  plan: {
    command: string;
    args: readonly string[];
    cwd: string;
    backendSessionId: string | null;
    monitorPresent: boolean;
    sidecarKinds: readonly string[];
  };
  titleCalls: ClientRecords;
};

const cases = [
  {
    name: "detects the opencode executable",
    input: { kind: "detect" as const, command: "/usr/local/bin/opencode" },
    assert: [
      returns<EmptyContext, PluginResult>({
        detected: { agentId: "opencode", confidence: 1 },
        plan: {} as never,
        titleCalls: { createdTitles: [], renamedSessions: [] },
      }),
    ],
  },
  {
    name: "prepares a launch that attaches the TUI to the owned server",
    input: { kind: "prepare" as const },
    assert: [
      returns<EmptyContext, PluginResult>({
        detected: null,
        plan: {
          command: "opencode",
          args: ["attach", "http://127.0.0.1:49152", "--dir", "/workspace", "--session", "session-created"],
          cwd: "/workspace",
          backendSessionId: "session-created",
          monitorPresent: true,
          sidecarKinds: ["opencode-serve"],
        },
        titleCalls: { createdTitles: [undefined], renamedSessions: [] },
      }),
    ],
  },
  {
    name: "titles the new session with the agent session name",
    input: { kind: "prepare" as const, name: "review" },
    assert: [
      returns<EmptyContext, PluginResult>({
        detected: null,
        plan: {
          command: "opencode",
          args: ["attach", "http://127.0.0.1:49152", "--dir", "/workspace", "--session", "session-created"],
          cwd: "/workspace",
          backendSessionId: "session-created",
          monitorPresent: true,
          sidecarKinds: ["opencode-serve"],
        },
        titleCalls: { createdTitles: ["review"], renamedSessions: [] },
      }),
    ],
  },
  {
    name: "resumes an existing session by its persisted id",
    input: { kind: "prepare-resume" as const },
    assert: [
      returns<EmptyContext, PluginResult>({
        detected: null,
        plan: {
          command: "opencode",
          args: ["attach", "http://127.0.0.1:49152", "--dir", "/workspace", "--session", "session-resumed"],
          cwd: "/workspace",
          backendSessionId: "session-resumed",
          monitorPresent: true,
          sidecarKinds: ["opencode-serve"],
        },
        titleCalls: { createdTitles: [], renamedSessions: [] },
      }),
    ],
  },
  {
    name: "keeps the agent session name on the resumed session title",
    input: { kind: "prepare-resume" as const, name: "review" },
    assert: [
      returns<EmptyContext, PluginResult>({
        detected: null,
        plan: {
          command: "opencode",
          args: ["attach", "http://127.0.0.1:49152", "--dir", "/workspace", "--session", "session-resumed"],
          cwd: "/workspace",
          backendSessionId: "session-resumed",
          monitorPresent: true,
          sidecarKinds: ["opencode-serve"],
        },
        titleCalls: { createdTitles: [], renamedSessions: [{ sessionId: "session-resumed", title: "review" }] },
      }),
    ],
  },
  {
    name: "rejects a resume when the session no longer exists",
    input: { kind: "prepare-resume-missing" as const },
    assert: [hasError<EmptyContext, PluginResult>({ code: "opencode_session_not_found", message: /no longer exists/ })],
  },
  {
    name: "rejects a plain launch without preparation",
    input: { kind: "launch" as const },
    assert: [hasError<EmptyContext, PluginResult>({ code: "opencode_requires_prepare" })],
  },
] satisfies readonly OperationCase<"default", PluginInput, PluginResult, EmptyContext>[];

const table: OperationTable<undefined, "default", PluginInput, PluginResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: async (_fixture, input) => {
    const sessions: Record<string, unknown> = { "session-resumed": {} };
    const records: ClientRecords = { createdTitles: [], renamedSessions: [] };
    const plugin: AgentPluginV1 = createOpenCodePlugin({
      serverManager: fakeManager(),
      clientFactory: () => fakeClient(records, sessions),
      monitorFactory: (options: OpenCodeMonitorOptions) => {
        void options;
        return new PassThroughMonitor();
      },
    });
    switch (input.kind) {
      case "detect": {
        const detected = await plugin.detect({
          command: input.command ?? "opencode",
          args: [],
          cwd: "/workspace",
          environment: {},
        });
        return {
          detected: detected ? { agentId: detected.agentId, confidence: detected.confidence } : null,
          plan: {} as never,
          titleCalls: records,
        };
      }
      case "launch":
        await plugin.launch({ cwd: "/workspace", args: [], environment: {} });
        throw new Error("launch unexpectedly succeeded");
      case "prepare":
      case "prepare-resume":
      case "prepare-resume-missing": {
        const resumeSessionId =
          input.kind === "prepare" ? null : input.kind === "prepare-resume" ? "session-resumed" : "session-gone";
        const plan = await plugin.prepareLaunch!({
          cwd: "/workspace",
          args: [],
          environment: {},
          name: input.name,
          monitorContext: {
            sessionId: "mobile-session",
            executionId: "execution-1",
            cwd: "/workspace",
            startedAt: new Date().toISOString(),
            backendSessionId: resumeSessionId,
            environment: {},
          },
          resumeSessionId,
        });
        return {
          detected: null,
          plan: {
            command: plan.primary.command,
            args: plan.primary.args,
            cwd: plan.primary.cwd,
            backendSessionId: plan.backendSessionId ?? null,
            monitorPresent: Boolean(plan.monitor),
            sidecarKinds: plan.sidecars?.map((sidecar) => sidecar.kind) ?? [],
          },
          titleCalls: records,
        };
      }
    }
  },
  observe: () => ({}),
};

describe("opencode plugin", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});

class PassThroughMonitor implements AgentMonitor {
  public async start(sink: AgentObservationSink): Promise<void> {
    void sink;
  }

  public async stop(): Promise<void> {
    // Nothing to stop.
  }
}
