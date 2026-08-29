import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasError,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import { getProfile } from "./index.js";

type FixtureKey = "complete" | "missing" | "invalid";
type ProfileFixture = { repositoryRoot: string; home: string };
type ProfileInput = { name?: string; environment?: NodeJS.ProcessEnv };
type ProfileResult = ReturnType<typeof getProfile>;
type ProfileContext = {
  name: string | null;
  sourceFile: string | null;
  selectedValue: string | null;
  ambientValue: string | null;
  unrelatedValue: string | null;
};

const cases = [
  {
    name: "keeps ambient values when no profile is selected",
    fixture: "missing",
    input: { environment: { MUXIMO_ONLY_AMBIENT: "ambient" } },
    assert: [
      hasObserved<ProfileContext, ProfileResult>("name", null),
      hasObserved<ProfileContext, ProfileResult>("sourceFile", null),
      hasObserved<ProfileContext, ProfileResult>("selectedValue", null),
      hasObserved<ProfileContext, ProfileResult>("ambientValue", "ambient"),
    ],
  },
  {
    name: "loads an arbitrary named profile and overlays ambient values",
    fixture: "complete",
    input: {
      name: "dev",
      environment: { MUXIMO_TEST_VALUE: "ambient", MUXIMO_ONLY_AMBIENT: "ambient", MUXIMO_TEST_UNRELATED: "kept" },
    },
    assert: [
      hasObserved<ProfileContext, ProfileResult>("name", "dev"),
      hasObserved<ProfileContext, ProfileResult>("selectedValue", "profile"),
      hasObserved<ProfileContext, ProfileResult>("ambientValue", "ambient"),
      hasObserved<ProfileContext, ProfileResult>("unrelatedValue", "kept"),
    ],
  },
  {
    name: "makes the selected profile name authoritative",
    fixture: "complete",
    input: { name: "dev", environment: { MUXIMO_ENV: "ambient" } },
    assert: [hasObserved<ProfileContext, ProfileResult>("selectedValue", "profile")],
  },
  {
    name: "reports a missing named profile",
    fixture: "missing",
    input: { name: "dev" },
    assert: [hasError<ProfileContext, ProfileResult>({ message: /environment profile was not found/ })],
  },
  {
    name: "reports the source line for invalid profile syntax",
    fixture: "invalid",
    input: { name: "dev" },
    assert: [hasError<ProfileContext, ProfileResult>({ message: /\.env\.dev:2: expected KEY=VALUE/ })],
  },
  {
    name: "rejects profile names that could escape the repository",
    fixture: "complete",
    input: { name: "../dev" },
    assert: [hasError<ProfileContext, ProfileResult>({ message: /--env must contain only/ })],
  },
] satisfies readonly OperationCase<FixtureKey, ProfileInput, ProfileResult, ProfileContext>[];

const table: OperationTable<ProfileFixture, FixtureKey, ProfileInput, ProfileResult, ProfileContext> = {
  defaultFixture: () => createFixture("complete"),
  fixtures: {
    complete: () => createFixture("complete"),
    missing: () => createFixture("missing"),
    invalid: () => createFixture("invalid"),
  },
  cases,
  execute: (fixture, input) =>
    getProfile({
      name: input.name,
      cwd: fixture.repositoryRoot,
      baseEnvironment: { HOME: fixture.home, ...input.environment },
    }),
  observe: (fixture, result) =>
    result.ok
      ? {
          name: result.value.name ?? null,
          sourceFile: result.value.sourceFile?.replace(fixture.repositoryRoot, "<root>") ?? null,
          selectedValue: result.value.environment.MUXIMO_TEST_VALUE ?? null,
          ambientValue: result.value.environment.MUXIMO_ONLY_AMBIENT ?? null,
          unrelatedValue: result.value.environment.MUXIMO_TEST_UNRELATED ?? null,
        }
      : { name: null, sourceFile: null, selectedValue: null, ambientValue: null, unrelatedValue: null },
};

function createFixture(kind: FixtureKey) {
  const root = mkdtempSync(join(tmpdir(), "muximo-profile-test-"));
  const repositoryRoot = join(root, "repository");
  const home = join(root, "home");
  mkdirSync(join(repositoryRoot, "apps"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(repositoryRoot, "package.json"), "{}\n");
  if (kind === "complete") {
    writeFileSync(
      join(repositoryRoot, ".env.dev"),
      "MUXIMO_TEST_VALUE=profile\nMUXIMO_AMBIENT_VALUE=profile\nMUXIMO_ENV=from-file\n",
    );
  }
  if (kind === "invalid")
    writeFileSync(join(repositoryRoot, ".env.dev"), "MUXIMO_TEST_VALUE=profile\nnot a profile line\n");
  return {
    fixture: { repositoryRoot, home },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("profile loader", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
