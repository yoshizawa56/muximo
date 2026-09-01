import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentExecutionSpec } from "@muximo/application";
import {
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { AttachedAgentExecutionAdapter } from "./agent-execution.js";

type FixtureKey = "blocked-attachment";
type Input = {};
type Result = {
  processCode: number;
  attachmentStarted: boolean;
  attachmentCompleted: boolean;
  processCompletedBeforeAttachment: boolean;
};
type Fixture = {
  root: string;
  executable: string;
  adapter: AttachedAgentExecutionAdapter;
  releaseAttachment: () => void;
  attachmentStartedPromise: Promise<void>;
  markAttachmentStarted: () => void;
  attachmentStarted: boolean;
  attachmentCompleted: boolean;
};

const cases = [
  {
    name: "does not let a blocked daemon attachment delay the provider process",
    fixture: "blocked-attachment" as const,
    input: {},
    assert: [
      returns<Result, Result>({
        processCode: 0,
        attachmentStarted: true,
        attachmentCompleted: true,
        processCompletedBeforeAttachment: true,
      }),
    ],
  },
] satisfies readonly OperationCase<FixtureKey, Input, Result, Result>[];

const table: OperationTable<Fixture, FixtureKey, Input, Result, Result> = {
  defaultFixture: (registerCleanup) => createFixture(registerCleanup),
  fixtures: {
    "blocked-attachment": (registerCleanup) => createFixture(registerCleanup),
  },
  cases,
  execute: async (fixture) => {
    let processCompletedBeforeAttachment = false;
    const execution = fixture.adapter.execute(createExecutionSpec(fixture), {
      onStarted: async () => {
        fixture.attachmentStarted = true;
        fixture.markAttachmentStarted();
        await new Promise<void>((resolve) => {
          fixture.releaseAttachment = resolve;
        });
        fixture.attachmentCompleted = true;
      },
    });
    await fixture.attachmentStartedPromise;
    const outcome = await Promise.race([
      execution.then(() => "process-completed" as const),
      new Promise<"attachment-blocked">((resolve) => setTimeout(() => resolve("attachment-blocked"), 2_000)),
    ]);
    processCompletedBeforeAttachment = outcome === "process-completed";
    fixture.releaseAttachment();
    const result = await execution;
    return {
      processCode: result.code,
      attachmentStarted: fixture.attachmentStarted,
      attachmentCompleted: fixture.attachmentCompleted,
      processCompletedBeforeAttachment,
    };
  },
  observe: (fixture, result) =>
    result.ok
      ? result.value
      : {
          processCode: -1,
          attachmentStarted: fixture.attachmentStarted,
          attachmentCompleted: fixture.attachmentCompleted,
          processCompletedBeforeAttachment: false,
        },
};

function createFixture(registerCleanup?: (cleanup: () => void) => void): { fixture: Fixture } {
  const root = mkdtempSync(join(tmpdir(), "muximo-agent-execution-"));
  const executable = join(root, "provider");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  chmodSync(executable, 0o700);
  let markAttachmentStarted!: () => void;
  const attachmentStartedPromise = new Promise<void>((resolve) => {
    markAttachmentStarted = resolve;
  });
  const fixture: Fixture = {
    root,
    executable,
    adapter: new AttachedAgentExecutionAdapter(),
    releaseAttachment: () => undefined,
    attachmentStartedPromise,
    markAttachmentStarted,
    attachmentStarted: false,
    attachmentCompleted: false,
  };
  if (registerCleanup) registerCleanup(() => rmSync(root, { recursive: true, force: true }));
  return { fixture };
}

function createExecutionSpec(fixture: Fixture): AgentExecutionSpec {
  return {
    sessionId: "session-id",
    executionId: "execution-id",
    sessionName: "review",
    backend: "opencode",
    command: [fixture.executable],
    cwd: fixture.root,
    environment: {},
  };
}

describe("CLI-owned agent execution", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
