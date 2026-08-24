import { describe, it } from "bun:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Assertion, type OperationCase, type OperationTable, runOperationTable } from "@muximo/test-support";
import { assertRequiredBuildArtifacts, createMuximoBuildPlan } from "./build-muximo.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

type BuildPlan = {
  repositoryRoot: string;
  outputPath: string;
  muximodOutputPath: string;
  target: string | undefined;
  cliEntrypoint: string;
  muximodEntrypoint: string;
  syncEmbeddedMigrationsScript: string;
  embeddedMigrationsDirectory: string;
  embeddedMigrationsJournal: string;
};
type Fixture = { repositoryRoot: string };
type Input = { output: string };
type Context = { plan: BuildPlan | undefined };

const succeeds = (name: string, check: (plan: BuildPlan) => void): Assertion<Context, BuildPlan> => ({
  name,
  check: (context, outcome) => {
    assert.equal(outcome.ok, true);
    check(context.plan as BuildPlan);
  },
});

const fails = (name: string, check: (error: unknown) => void): Assertion<Context, BuildPlan> => ({
  name,
  allowsOutcomeError: true,
  check: (_context, outcome) => {
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    check(outcome.error);
  },
});

const cases = [
  {
    name: "uses the repository root for the binary and embedded migration inputs",
    input: { output: "dist/muximo" },
    assert: [
      succeeds("resolves the canonical infrastructure migration directory", (plan) => {
        assert.equal(plan.repositoryRoot, repositoryRoot);
        assert.equal(plan.outputPath, join(repositoryRoot, "dist", "muximo"));
        assert.equal(plan.muximodOutputPath, join(repositoryRoot, "dist", "muximod"));
        assert.equal(plan.cliEntrypoint, join(repositoryRoot, "apps", "muximo-cli", "src", "index.ts"));
        assert.equal(plan.muximodEntrypoint, join(repositoryRoot, "apps", "muximod", "src", "index.ts"));
        assert.equal(
          plan.syncEmbeddedMigrationsScript,
          join(repositoryRoot, "scripts", "sync-embedded-migrations.mjs"),
        );
        assert.equal(plan.embeddedMigrationsDirectory, join(repositoryRoot, "packages", "infrastructure", "drizzle"));
        assert.doesNotMatch(JSON.stringify(plan), /packages[\\/]persistence[\\/]drizzle/);
      }),
    ],
  },
  {
    name: "reports a missing required build artifact before spawning a command",
    fixture: "missing-repository",
    input: { output: "dist/muximo" },
    assert: [
      fails("identifies the missing CLI entrypoint", (error) => {
        assert.match(String(error), /required muximo CLI entrypoint not found:/);
      }),
    ],
  },
] satisfies readonly OperationCase<"default" | "missing-repository", Input, BuildPlan, Context>[];

const table = {
  defaultFixture: () => ({ fixture: { repositoryRoot } }),
  fixtures: {
    "missing-repository": () => {
      const missingRoot = mkdtempSync(join(tmpdir(), "muximo-build-test-"));
      return {
        fixture: { repositoryRoot: missingRoot },
        cleanup: () => rmSync(missingRoot, { recursive: true, force: true }),
      };
    },
  },
  cases,
  execute: (fixture, input) => {
    const plan = createMuximoBuildPlan({ repositoryRoot: fixture.repositoryRoot, output: input.output }) as BuildPlan;
    assertRequiredBuildArtifacts(plan);
    return plan;
  },
  observe: (_fixture, outcome) => ({ plan: outcome.ok ? outcome.value : undefined }),
} satisfies OperationTable<Fixture, "default" | "missing-repository", Input, BuildPlan, Context>;

describe("muximo build plan", () => {
  runOperationTable(it, table);
});
