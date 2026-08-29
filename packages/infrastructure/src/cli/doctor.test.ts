import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type FixtureHandle,
  hasObserved,
  type OperationCase,
  type OperationTable,
  runOperationTable,
  type TestRegistrar,
} from "@muximo/test-support";
import { describe, it } from "vitest";
import type { DoctorReport } from "./doctor.js";
import { runDoctor } from "./doctor.js";

type DoctorFixture = {
  root: string;
  environment: NodeJS.ProcessEnv;
  report?: DoctorReport;
};

type DoctorInput = { verbose: boolean };
type DoctorContext = { status: number; missingCommands: readonly string[]; details: boolean };
type DoctorFixtureKey = "missing" | "available" | "profile-missing";

const cases = [
  {
    name: "returns missing required command diagnostics without writing output",
    fixture: "missing",
    input: { verbose: false },
    assert: [
      hasObserved<DoctorContext, DoctorReport>("status", 1),
      hasObserved<DoctorContext, DoctorReport>("missingCommands", ["git", "zsh", "codex", "claude", "opencode"]),
      hasObserved<DoctorContext, DoctorReport>("details", false),
    ],
  },
  {
    name: "returns available command and profile data for verbose diagnostics",
    fixture: "available",
    input: { verbose: true },
    assert: [
      hasObserved<DoctorContext, DoctorReport>("status", 0),
      hasObserved<DoctorContext, DoctorReport>("missingCommands", []),
      hasObserved<DoctorContext, DoctorReport>("details", true),
    ],
  },
  {
    name: "marks a configured but missing Codex profile as invalid",
    fixture: "profile-missing",
    input: { verbose: false },
    assert: [
      hasObserved<DoctorContext, DoctorReport>("status", 1),
      hasObserved<DoctorContext, DoctorReport>("missingCommands", []),
    ],
  },
] satisfies readonly OperationCase<DoctorFixtureKey, DoctorInput, DoctorReport, DoctorContext>[];

const table: OperationTable<DoctorFixture, DoctorFixtureKey, DoctorInput, DoctorReport, DoctorContext> = {
  defaultFixture: () => createDoctorFixture("missing"),
  fixtures: {
    missing: () => createDoctorFixture("missing"),
    available: () => createDoctorFixture("available"),
    "profile-missing": () => createDoctorFixture("profile-missing"),
  },
  cases,
  execute: (fixture, input) => {
    const report = runDoctor(input, {
      environment: fixture.environment,
      defaultRemote: "unix://",
      logger: { child: () => ({ debug: () => undefined }) },
    });
    fixture.report = report;
    return report;
  },
  observe: (fixture) => ({
    status: fixture.report?.status ?? -1,
    missingCommands: fixture.report?.commands.filter((check) => !check.path).map((check) => check.command) ?? [],
    details: fixture.report?.details !== undefined,
  }),
};

function createDoctorFixture(
  kind: DoctorFixtureKey,
  registerCleanup?: (cleanup: () => void) => void,
): FixtureHandle<DoctorFixture> {
  const root = mkdtempSync(join(tmpdir(), "muximo-doctor-"));
  const environment: NodeJS.ProcessEnv = { PATH: root };
  if (kind !== "missing") {
    for (const command of ["git", "zsh", "codex", "claude", "opencode", "mise"]) {
      const path = join(root, command);
      writeFileSync(path, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      chmodSync(path, 0o700);
    }
  }
  if (kind === "available") {
    const codexHome = join(root, "codex-home");
    const profile = join(codexHome, "review.config.toml");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(profile, "profile = true\n", { mode: 0o600 });
    environment.CODEX_HOME = codexHome;
    environment.MUXIMO_CODEX_PROFILE = "review";
  }
  if (kind === "profile-missing") {
    environment.CODEX_HOME = join(root, "codex-home");
    environment.MUXIMO_CODEX_PROFILE = "missing";
  }
  const fixture = { root, environment };
  if (registerCleanup) registerCleanup(() => rmSync(root, { recursive: true, force: true }));
  return { fixture, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("typed doctor adapter", () => {
  runOperationTable(it as unknown as TestRegistrar, table);
});
