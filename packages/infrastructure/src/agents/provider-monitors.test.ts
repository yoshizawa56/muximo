import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  noFixture,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { AgentMonitor, AgentObservation } from "./index.js";
import { createClaudeMonitor, createCodexMonitor } from "./provider-monitors.js";

type MonitorInput = {
  provider: "codex" | "claude";
  records: readonly string[];
  appendRecords?: readonly string[];
  sessionId: string;
};
type MonitorResult = {
  states: readonly string[];
  outputs: readonly string[];
};
type EmptyContext = {};

const cases = [
  {
    name: "maps Codex structured completion to waiting for input",
    input: {
      provider: "codex",
      sessionId: "codex-thread",
      records: [
        '{"type":"session_meta","payload":{"session_id":"codex-thread","cwd":"/workspace","originator":"codex_cli_rs"}}',
        '{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"The task is complete."}]}}',
        '{"type":"event_msg","payload":{"type":"agent_message","message":"The task is complete."}}',
        '{"type":"event_msg","payload":{"type":"task_complete"}}',
      ],
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["running", "waiting_input"],
        outputs: ["The task is complete."],
      }),
    ],
  },
  {
    name: "maps Claude structured question requests to waiting for input",
    input: {
      provider: "claude",
      sessionId: "claude-session",
      records: [
        '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Start"}]}}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"I need one detail."}]}}',
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"AskUserQuestion","input":{}}]}}',
      ],
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["running", "running", "waiting_input"],
        outputs: ["I need one detail."],
      }),
    ],
  },
  {
    name: "maps Claude permission requests to waiting for approval",
    input: {
      provider: "claude",
      sessionId: "claude-approval",
      records: [
        '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"ExitPlanMode","input":{}}]}}',
      ],
    },
    assert: [returns<EmptyContext, MonitorResult>({ states: ["waiting_approval"], outputs: [] })],
  },
  {
    name: "observes a provider state appended after startup",
    input: {
      provider: "codex",
      sessionId: "codex-live-thread",
      records: [
        '{"type":"session_meta","payload":{"session_id":"codex-live-thread","cwd":"/workspace","originator":"codex_cli_rs"}}',
        '{"type":"task_started"}',
      ],
      appendRecords: ['{"type":"task_complete","last_agent_message":"Finished while monitored."}'],
    },
    assert: [
      returns<EmptyContext, MonitorResult>({
        states: ["running", "waiting_input"],
        outputs: ["Finished while monitored."],
      }),
    ],
  },
] satisfies readonly OperationCase<"default", MonitorInput, MonitorResult, EmptyContext>[];

const table: OperationTable<undefined, "default", MonitorInput, MonitorResult, EmptyContext> = {
  defaultFixture: noFixture(),
  cases,
  execute: async (_fixture, input) => {
    const root = mkdtempSync(join(tmpdir(), "muximo-plugin-monitor-"));
    try {
      const providerRoot =
        input.provider === "codex" ? join(root, "sessions", "2026", "08") : join(root, "projects", "workspace");
      mkdirSync(providerRoot, { recursive: true });
      const file = join(providerRoot, `${input.sessionId}.jsonl`);
      writeFileSync(file, `${input.records.join("\n")}\n`);
      const monitor: AgentMonitor =
        input.provider === "codex"
          ? createCodexMonitor({
              sessionId: "mobile-session",
              executionId: "execution-id",
              cwd: "/workspace",
              startedAt: new Date(Date.now() - 1_000).toISOString(),
              backendSessionId: input.sessionId,
              environment: { CODEX_HOME: root, HOME: root },
            })
          : createClaudeMonitor({
              sessionId: "mobile-session",
              executionId: "execution-id",
              cwd: "/workspace",
              startedAt: new Date(Date.now() - 1_000).toISOString(),
              backendSessionId: input.sessionId,
              environment: { CLAUDE_CONFIG_DIR: root, HOME: root },
            });
      const observations: AgentObservation[] = [];
      await monitor.start((observation) => {
        observations.push(observation);
      });
      if (input.appendRecords) {
        appendFileSync(file, `${input.appendRecords.join("\n")}\n`);
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      await monitor.stop();
      return {
        states: observations
          .filter(
            (observation): observation is Extract<AgentObservation, { type: "state_changed" }> =>
              observation.type === "state_changed",
          )
          .map((observation) => observation.state),
        outputs: observations
          .filter(
            (observation): observation is Extract<AgentObservation, { type: "state_changed" }> =>
              observation.type === "state_changed" && Boolean(observation.recentOutput),
          )
          .map((observation) => observation.recentOutput!),
      };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  observe: () => ({}),
};

describe("provider agent monitors", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
