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
import { isProcessStartTimeValid, spawnAttached } from "./process.js";

type FixtureKey = "stderr-failure" | "successful-stderr" | "spawn-failure" | "long-secret-failure" | "c1-failure";
type Input = {};
type Result = { started: boolean; code: number; diagnostic: string | undefined };
type Context = Result;
type Fixture = { root: string; executable: string };

const cases = [
  {
    name: "captures and sanitizes a failed process diagnostic",
    fixture: "stderr-failure" as const,
    input: {},
    assert: [
      returns<Context, Result>({
        started: true,
        code: 1,
        diagnostic: "Codex failed: stdin is not a terminal --token=[REDACTED]",
      }),
    ],
  },
  {
    name: "does not expose stderr from a successful process as a failure diagnostic",
    fixture: "successful-stderr" as const,
    input: {},
    assert: [returns<Context, Result>({ started: true, code: 0, diagnostic: undefined })],
  },
  {
    name: "reports a spawn failure as a process diagnostic",
    fixture: "spawn-failure" as const,
    input: {},
    assert: [
      hasObserved<Context, Result>("code", 127),
      hasObserved<Context, Result>("started", false),
      {
        name: "includes the spawn error code",
        check: (context: Context) => expect(context.diagnostic).toContain("ENOENT"),
      },
    ],
  },
  {
    name: "redacts a long secret before retaining the diagnostic tail",
    fixture: "long-secret-failure" as const,
    input: {},
    assert: [
      hasObserved<Context, Result>("started", true),
      hasObserved<Context, Result>("code", 1),
      {
        name: "does not retain the secret suffix",
        check: (context: Context) => {
          expect(context.diagnostic).not.toContain("secret-value");
          expect(context.diagnostic).toContain("--token=[REDACTED]");
        },
      },
    ],
  },
  {
    name: "removes C1 terminal control sequences from diagnostics",
    fixture: "c1-failure" as const,
    input: {},
    assert: [returns<Context, Result>({ started: true, code: 1, diagnostic: "unsafe output" })],
  },
] satisfies readonly OperationCase<FixtureKey, Input, Result, Context>[];

const table: OperationTable<Fixture, FixtureKey, Input, Result, Context> = {
  defaultFixture: (registerCleanup) => createFixture("stderr-failure", registerCleanup),
  fixtures: {
    "stderr-failure": (registerCleanup) => createFixture("stderr-failure", registerCleanup),
    "successful-stderr": (registerCleanup) => createFixture("successful-stderr", registerCleanup),
    "spawn-failure": (registerCleanup) => createFixture("spawn-failure", registerCleanup),
    "long-secret-failure": (registerCleanup) => createFixture("long-secret-failure", registerCleanup),
    "c1-failure": (registerCleanup) => createFixture("c1-failure", registerCleanup),
  },
  cases,
  execute: (fixture) =>
    spawnAttached(fixture.executable, [], fixture.root, process.env, { captureFailureDiagnostic: true }).then(
      (result) => ({ started: result.started, code: result.code, diagnostic: result.failureDiagnostic }),
    ),
  observe: (_fixture, result) => (result.ok ? result.value : { started: false, code: -1, diagnostic: undefined }),
};

function createFixture(key: FixtureKey, registerCleanup?: (cleanup: () => void) => void): FixtureHandle<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "muximo-process-"));
  const executable = join(root, "backend");
  if (key !== "spawn-failure") {
    const longSecret = "s".repeat(20_000);
    const script =
      key === "stderr-failure"
        ? "#!/bin/sh\nprintf '\\033[31mCodex failed: stdin is not a terminal\\033[0m --token=\"secret\\n' >&2\nexit 1\n"
        : key === "successful-stderr"
          ? "#!/bin/sh\nprintf 'ignored stderr\\n' >&2\nexit 0\n"
          : key === "long-secret-failure"
            ? `#!/bin/sh\nprintf '%s' '--token=${longSecret}' >&2\nprintf '\\n' >&2\nexit 1\n`
            : "#!/bin/sh\nprintf '\\302\\23331munsafe output\\302\\2330m\\n' >&2\nexit 1\n";
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

type IdentityInput = { expectedStartedAt: string; actualStartedAtMs: number };
type IdentityResult = { valid: boolean };
type IdentityFixture = Record<string, never>;

const identityCases = [
  {
    name: "accepts a process that started before the recorded execution",
    input: { expectedStartedAt: "2026-08-23T00:00:01.000Z", actualStartedAtMs: Date.parse("2026-08-23T00:00:00.000Z") },
    assert: [returns<IdentityResult, IdentityResult>({ valid: true })],
  },
  {
    name: "rejects a process that started after the recorded execution",
    input: { expectedStartedAt: "2026-08-23T00:00:00.000Z", actualStartedAtMs: Date.parse("2026-08-23T00:00:01.000Z") },
    assert: [returns<IdentityResult, IdentityResult>({ valid: false })],
  },
  {
    name: "rejects an invalid recorded execution timestamp",
    input: { expectedStartedAt: "not-a-timestamp", actualStartedAtMs: 0 },
    assert: [returns<IdentityResult, IdentityResult>({ valid: false })],
  },
] satisfies readonly OperationCase<"default", IdentityInput, IdentityResult, IdentityResult>[];

const identityTable: OperationTable<IdentityFixture, "default", IdentityInput, IdentityResult, IdentityResult> = {
  defaultFixture: () => ({ fixture: {} }),
  cases: identityCases,
  execute: async (_fixture, input) => ({
    valid: isProcessStartTimeValid(input.expectedStartedAt, input.actualStartedAtMs),
  }),
  observe: (_fixture, result) => (result.ok ? result.value : { valid: false }),
};

describe("process identity", () => {
  runOperationTable(it as unknown as TestRegistrar, identityTable);
});
