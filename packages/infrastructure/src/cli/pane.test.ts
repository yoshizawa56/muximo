import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSession, AgentSessionId, WorkspaceId } from "@muximo/domain";
import { TmuxAdapter, TmuxPanePublicationAdapter } from "@muximo/infrastructure";
import {
  hasEvents,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { createLogger, type Logger, type LogRecord } from "../logging/index.js";

type PaneFixture = {
  root: string;
  events: string[];
  observations: Array<{ state: string; recentOutput?: string }>;
  paneOptions: Array<{ name: string; value: string }>;
  paneWrites: Array<{ name: string; value: string }>;
  diagnostics: LogRecord[];
  logger: Logger;
  tmux: RecordingTmux;
  adapter: TmuxPanePublicationAdapter;
};

type PaneResult = {
  events: readonly string[];
  observations: readonly { state: string; recentOutput?: string }[];
  paneOptions: readonly { name: string; value: string }[];
  diagnosticEvents: readonly string[];
};

type Input = { mode: "success" | "fallback" | "failure"; operation: "lifecycle" | "observation" };

const cases = [
  {
    name: "adopts and releases through the control socket in order",
    input: { mode: "success", operation: "lifecycle" },
    assert: [
      hasEvents<PaneResult, PaneResult>("events", ["connect", "adopt", "close", "connect", "release", "close"]),
      hasObserved<PaneResult, PaneResult>("observations", []),
      hasObserved<PaneResult, PaneResult>("paneOptions", []),
      hasObserved<PaneResult, PaneResult>("diagnosticEvents", []),
    ],
  },
  {
    name: "falls back to pane metadata when the control socket is unavailable",
    input: { mode: "fallback", operation: "lifecycle" },
    assert: [
      {
        name: "writes session and execution metadata for adoption",
        check: (context: PaneResult) => {
          expect(context.paneOptions.slice(0, 2)).toEqual([
            { name: "@muximod.agent_session_id", value: "session-id" },
            { name: "@muximod.agent_execution_id", value: "execution-id" },
          ]);
        },
      },
      {
        name: "restores shell metadata after release",
        check: (context: PaneResult) => {
          expect(context.events).toContain("reset-shell-metadata");
        },
      },
      hasObserved<PaneResult, PaneResult>("events", ["connect", "connect", "reset-shell-metadata"]),
      hasObserved<PaneResult, PaneResult>("observations", []),
      hasObserved<PaneResult, PaneResult>("diagnosticEvents", []),
    ],
  },
  {
    name: "records control operation failures as structured diagnostics",
    input: { mode: "failure", operation: "lifecycle" },
    assert: [
      hasObserved<PaneResult, PaneResult>("events", ["connect", "connect"]),
      hasObserved<PaneResult, PaneResult>("observations", []),
      hasObserved<PaneResult, PaneResult>("diagnosticEvents", ["pane.adopt_failed", "pane.release_failed"]),
    ],
  },
  {
    name: "publishes provider state and recent output through the control socket",
    input: { mode: "success", operation: "observation" },
    assert: [
      hasObserved<PaneResult, PaneResult>("events", ["connect", "observe", "close"]),
      hasObserved<PaneResult, PaneResult>("observations", [{ state: "waiting_input", recentOutput: "Need input" }]),
      hasObserved<PaneResult, PaneResult>("paneOptions", []),
      hasObserved<PaneResult, PaneResult>("diagnosticEvents", []),
    ],
  },
] satisfies readonly OperationCase<"default", Input, PaneResult, PaneResult>[];

const table: OperationTable<PaneFixture, "default", Input, PaneResult, PaneResult> = {
  defaultFixture: createPaneFixture,
  cases,
  execute: async (fixture, input) => {
    fixture.adapter = createAdapter(fixture, input.mode);
    const session = AgentSession.create({
      id: AgentSessionId.create("session-id"),
      name: "session",
      backend: "claude",
      status: "running",
      workspaceId: WorkspaceId.create("workspace-id"),
      workspaceRoot: fixture.root,
      workspaceName: "workspace",
      useWorktree: false,
      setupRan: false,
      resuming: false,
      executionId: "execution-id",
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
    });
    if (input.operation === "lifecycle") {
      await fixture.adapter.adopt(session);
      await fixture.adapter.release(session);
    } else {
      await fixture.adapter.observe(session, { state: "waiting_input", recentOutput: "Need input" });
    }
    return {
      events: fixture.events,
      observations: fixture.observations,
      paneOptions: fixture.paneWrites,
      diagnosticEvents: fixture.diagnostics.map((record) => record.event),
    };
  },
  observe: (fixture) => ({
    events: fixture.events,
    observations: fixture.observations,
    paneOptions: fixture.paneWrites,
    diagnosticEvents: fixture.diagnostics.map((record) => record.event),
  }),
};

function createPaneFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: PaneFixture } {
  const root = mkdtempSync(join(tmpdir(), "muximo-pane-adapter-"));
  const events: string[] = [];
  const observations: PaneFixture["observations"] = [];
  const paneOptions: PaneFixture["paneOptions"] = [];
  const paneWrites: PaneFixture["paneWrites"] = [];
  const diagnostics: LogRecord[] = [];
  const logger = createLogger({
    service: "pane-adapter-test",
    mode: "attached",
    level: "debug",
    clock: () => new Date("2026-08-23T00:00:00.000Z"),
    sink: { write: (record) => diagnostics.push(record) },
  });
  const tmux = new RecordingTmux(events, paneOptions, paneWrites);
  const fixture: PaneFixture = {
    root,
    events,
    observations,
    paneOptions,
    paneWrites,
    diagnostics,
    logger,
    tmux,
    adapter: undefined as unknown as TmuxPanePublicationAdapter,
  };
  fixture.adapter = createAdapter(fixture, "success");
  const cleanup = () => {
    logger.close();
    rmSync(root, { recursive: true, force: true });
  };
  if (registerCleanup) registerCleanup(cleanup);
  return { fixture };
}

function createAdapter(fixture: PaneFixture, mode: Input["mode"]): TmuxPanePublicationAdapter {
  return new TmuxPanePublicationAdapter({
    environment: { TMUX: "1", TMUX_PANE: "%1", MUXIMOD_MANAGED_SESSION_ID: "managed-id" },
    databaseFile: join(fixture.root, "muximod.sqlite"),
    tmux: fixture.tmux,
    connect: async () => {
      fixture.events.push("connect");
      if (mode === "fallback") throw Object.assign(new Error("control socket unavailable"), { code: "ECONNREFUSED" });
      if (mode === "failure") throw Object.assign(new Error("control operation failed"), { code: "EIO" });
      return {
        adoptAgentSession: async () => {
          fixture.events.push("adopt");
        },
        releaseAgentSession: async () => {
          fixture.events.push("release");
        },
        observeAgentSession: async (input) => {
          fixture.events.push("observe");
          fixture.observations.push({ state: input.state, recentOutput: input.recentOutput });
        },
        close: () => {
          fixture.events.push("close");
        },
      };
    },
    logger: fixture.logger,
  });
}

class RecordingTmux extends TmuxAdapter {
  public constructor(
    private readonly events: string[],
    private readonly options: PaneFixture["paneOptions"],
    private readonly writes: PaneFixture["paneWrites"],
  ) {
    super("/tmp/muximo-pane-adapter.sock");
  }

  public override setPaneOption(_paneId: string, name: string, value: string): void {
    this.options.push({ name, value });
    this.writes.push({ name, value });
  }

  public override command(args: string[]): { status: number; stdout: string; stderr: string } {
    if (args[0] === "show-options") {
      return {
        status: 0,
        stdout: this.options.find((option) => option.name === "@muximod.agent_execution_id")?.value ?? "",
        stderr: "",
      };
    }
    if (args[0] === "set-option" && args.includes("-u")) {
      const name = args.at(-1);
      if (name) {
        const index = this.options.findIndex((option) => option.name === name);
        if (index >= 0) this.options.splice(index, 1);
      }
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }

  public override resetAgentPaneMetadata(_paneId: string): void {
    this.events.push("reset-shell-metadata");
  }
}

describe("tmux pane publication CLI adapter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
