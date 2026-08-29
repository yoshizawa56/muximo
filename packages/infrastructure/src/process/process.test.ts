import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  returns,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, expect, it } from "vitest";
import { spawnAttached } from "./process.js";

type FixtureKey = "stderr-failure" | "successful-stderr" | "spawn-failure";
type Input = {};
type Result = { code: number; diagnostic: string | undefined };
type Context = Result;
type Fixture = { root: string; executable: string };

const cases = [
  {
    name: "captures and sanitizes a failed process diagnostic",
    fixture: "stderr-failure" as const,
    input: {},
    assert: [
      returns<Context, Result>({
        code: 1,
        diagnostic: "Codex failed: stdin is not a terminal --token=[REDACTED]",
      }),
    ],
  },
  {
    name: "does not expose stderr from a successful process as a failure diagnostic",
    fixture: "successful-stderr" as const,
    input: {},
    assert: [returns<Context, Result>({ code: 0, diagnostic: undefined })],
  },
  {
    name: "reports a spawn failure as a process diagnostic",
    fixture: "spawn-failure" as const,
    input: {},
    assert: [
      hasObserved<Context, Result>("code", 127),
      {
        name: "includes the spawn error code",
        check: (context: Context) => expect(context.diagnostic).toContain("ENOENT"),
      },
    ],
  },
] satisfies readonly OperationCase<FixtureKey, Input, Result, Context>[];

const table: OperationTable<Fixture, FixtureKey, Input, Result, Context> = {
  defaultFixture: (registerCleanup) => createFixture("stderr-failure", registerCleanup),
  fixtures: {
    "stderr-failure": (registerCleanup) => createFixture("stderr-failure", registerCleanup),
    "successful-stderr": (registerCleanup) => createFixture("successful-stderr", registerCleanup),
    "spawn-failure": (registerCleanup) => createFixture("spawn-failure", registerCleanup),
  },
  cases,
  execute: (fixture) =>
    spawnAttached(fixture.executable, [], fixture.root, process.env, { captureFailureDiagnostic: true }).then(
      (result) => ({ code: result.code, diagnostic: result.failureDiagnostic }),
    ),
  observe: (_fixture, result) => (result.ok ? result.value : { code: -1, diagnostic: undefined }),
};

function createFixture(key: FixtureKey, registerCleanup?: (cleanup: () => void) => void): FixtureHandle<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "muximo-process-"));
  const executable = join(root, "backend");
  if (key !== "spawn-failure") {
    const script =
      key === "stderr-failure"
        ? "#!/bin/sh\nprintf '\\033[31mCodex failed: stdin is not a terminal\\033[0m --token=secret\\n' >&2\nexit 1\n"
        : "#!/bin/sh\nprintf 'ignored stderr\\n' >&2\nexit 0\n";
    writeFileSync(executable, script, { mode: 0o700 });
    chmodSync(executable, 0o700);
  }
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  if (registerCleanup) registerCleanup(cleanup);
  return { fixture: { root, executable } };
}

describe("attached process diagnostics", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
