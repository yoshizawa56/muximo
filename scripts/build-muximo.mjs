#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function createMuximoBuildPlan({
  repositoryRoot = defaultRepositoryRoot,
  output = process.env.MUXIMO_BUILD_OUTPUT ?? "dist/muximo",
  target = process.env.MUXIMO_BUILD_TARGET,
} = {}) {
  const root = resolve(repositoryRoot);
  const outputPath = isAbsolute(output) ? resolve(output) : join(root, output);
  const infrastructureMigrationsDirectory = join(root, "packages", "infrastructure", "drizzle");

  return {
    repositoryRoot: root,
    outputPath,
    target,
    productionEntrypoint: join(root, "scripts", "muximo-production-entrypoint.ts"),
    syncEmbeddedMigrationsScript: join(root, "scripts", "sync-embedded-migrations.mjs"),
    embeddedMigrationsDirectory: infrastructureMigrationsDirectory,
    embeddedMigrationsJournal: join(infrastructureMigrationsDirectory, "meta", "_journal.json"),
  };
}

export function assertRequiredBuildArtifacts(plan) {
  const requiredArtifacts = [
    ["muximo production entrypoint", plan.productionEntrypoint, "file"],
    ["embedded migration sync script", plan.syncEmbeddedMigrationsScript, "file"],
    ["canonical infrastructure migrations directory", plan.embeddedMigrationsDirectory, "directory"],
    ["canonical infrastructure migration journal", plan.embeddedMigrationsJournal, "file"],
  ];

  for (const [description, path, kind] of requiredArtifacts) {
    if (!existsSync(path)) throw new Error(`required ${description} not found: ${path}`);
    const actualKind = statSync(path).isDirectory() ? "directory" : "file";
    if (actualKind !== kind) throw new Error(`required ${description} is not a ${kind}: ${path}`);
  }
}

export function buildMuximo(options = {}) {
  const plan = createMuximoBuildPlan(options);
  assertRequiredBuildArtifacts(plan);

  mkdirSync(dirname(plan.outputPath), { recursive: true });
  run(process.execPath, [plan.syncEmbeddedMigrationsScript], plan.repositoryRoot);

  const buildArgs = ["build", plan.productionEntrypoint, "--compile", "--minify"];
  if (plan.target) buildArgs.push(`--target=${plan.target}`);
  buildArgs.push("--outfile", plan.outputPath);
  run(process.execPath, buildArgs, plan.repositoryRoot);

  return plan;
}

function run(command, args, cwd, environment = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    stdio: "inherit",
  });
  if (result.error) throw new Error(`could not run ${command}: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) {
    const status = result.signal ? `signal ${result.signal}` : `exit code ${result.status ?? "unknown"}`;
    throw new Error(`muximo build command failed with ${status}: ${command} ${args.join(" ")}`);
  }
}

if (import.meta.main) buildMuximo();
