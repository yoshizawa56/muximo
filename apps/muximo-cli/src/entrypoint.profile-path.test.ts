import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";

const sourceRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliEntrypoint = resolve(dirname(fileURLToPath(import.meta.url)), "index.ts");

type Fixture = { outsideDirectory: string };
type Input = { profileName: string };
type Result = { status: number | null; stderr: string };
type Context = Result;

const cases = [
  {
    name: "resolves a source profile independently of the caller directory",
    input: { profileName: "outside-cwd-test" },
    assert: [
      hasObserved<Context, Result>("status", 1),
      hasObserved<Context, Result>(
        "stderr",
        `[muximo-cli] error: the outside-cwd-test environment profile was not found: ${join(
          sourceRepositoryRoot,
          ".env.outside-cwd-test",
        )}\n`,
      ),
    ],
  },
] satisfies readonly OperationCase<"default", Input, Result, Context>[];

const table: OperationTable<Fixture, "default", Input, Result, Context> = {
  defaultFixture: createFixture,
  cases,
  execute: (fixture, input) => {
    const environment = { ...process.env };
    delete environment.MUXIMO_ENV;
    const result = spawnSync(
      process.execPath,
      ["--no-env-file", cliEntrypoint, "--env", input.profileName, "daemon", "status"],
      { cwd: fixture.outsideDirectory, env: environment, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    return { status: result.status, stderr: result.stderr };
  },
  observe: (_fixture, result) => (result.ok ? result.value : { status: null, stderr: String(result.error) }),
};

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "muximo-entrypoint-profile-test-"));
  const outsideDirectory = join(root, "outside");
  mkdirSync(outsideDirectory);
  return {
    fixture: { outsideDirectory },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("muximo profile entrypoint path", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
