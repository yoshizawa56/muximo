import type { RunAgentSessionResponse } from "@muximo/contract/api";
import { AgentSession, AgentSessionId, WorkspaceId } from "@muximo/domain";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { CliIo } from "../commands/types.js";
import { presentRunAgentSession } from "./session.js";

type Fixture = {
  result: RunAgentSessionResponse;
  out: string[];
  err: string[];
};

type Context = {
  out: string;
  err: string;
};

const session = AgentSession.create({
  id: AgentSessionId.create("session-id"),
  name: "test",
  backend: "codex",
  status: "exited",
  workspaceId: WorkspaceId.create("workspace-id"),
  workspaceRoot: "/workspace",
  workspaceName: "workspace",
  useWorktree: true,
  setupRan: false,
  resuming: false,
  lastActivityAt: "2026-08-29T00:00:00.000Z",
});

const cases = [
  {
    name: "presents the backend failure diagnostic before the cleanup result",
    fixture: "failure" as const,
    input: {},
    assert: [
      returns<Context, number>(1),
      hasObserved<Context, number>("err", "[muximo-cli] codex exited with exit code 1: stdin is not a terminal\n"),
      hasObserved<Context, number>("out", "[muximo-cli] session 'test' cleaned up\n"),
    ],
  },
  {
    name: "keeps the backend failure diagnostic when cleanup also fails",
    fixture: "cleanup-failed" as const,
    input: {},
    assert: [
      returns<Context, number>(1),
      hasObserved<Context, number>("err", "[muximo-cli] codex exited with exit code 1: stdin is not a terminal\n"),
      hasObserved<Context, number>(
        "out",
        "[muximo-cli] session 'test' retained because cleanup did not complete: remote archive failed (cleanup failed; resources were retained)\n",
      ),
    ],
  },
] satisfies readonly OperationCase<"failure" | "cleanup-failed", {}, number, Context>[];

const table: OperationTable<Fixture, "failure" | "cleanup-failed", {}, number, Context> = {
  defaultFixture: () => ({ fixture: createFixture("failure") }),
  fixtures: {
    failure: () => ({ fixture: createFixture("failure") }),
    "cleanup-failed": () => ({ fixture: createFixture("cleanup-failed") }),
  },
  cases,
  execute: (fixture) => presentRunAgentSession(fixture.result, createIo(fixture)),
  observe: (fixture) => ({ out: fixture.out.join(""), err: fixture.err.join("") }),
};

function createFixture(key: "failure" | "cleanup-failed"): Fixture {
  return {
    result: {
      process: {
        started: true,
        code: 1,
        interrupted: false,
        failureDiagnostic: "stdin is not a terminal",
      },
      session,
      cleanup:
        key === "failure" ? { disposition: "removed" } : { disposition: "failed", reason: "remote_archive_failed" },
    },
    out: [],
    err: [],
  };
}

function createIo(fixture: Fixture): CliIo {
  return {
    out: { write: (value: string) => fixture.out.push(value) },
    err: { write: (value: string) => fixture.err.push(value) },
  } as unknown as CliIo;
}

describe("agent session presenter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
