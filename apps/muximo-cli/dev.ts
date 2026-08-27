#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { createPushSchemaSynchronizer, defaultMuximodInstanceDirectory } from "@muximo/infrastructure";
import { loadDevelopmentEnvironment, resolveRepositoryRoot } from "@muximo/portless-support";
import { runMuximoCli } from "./src/entrypoint.js";

const repositoryRoot = resolveRepositoryRoot();
loadDevelopmentEnvironment({ repositoryRoot });
if (process.env.HOST) process.env.MUXIMOD_HOST = process.env.HOST;
if (process.env.PORT) process.env.MUXIMOD_PORT = process.env.PORT;
const worktreeProfile = configureDevelopmentWorktreeEnvironment(process.env, repositoryRoot);

const status = await runMuximoCli(process.argv.slice(2), {
  schemaSynchronizer: createPushSchemaSynchronizer({ force: true }),
  includeDevelopmentCommands: true,
  env: process.env,
  input: process.stdin,
  out: process.stdout,
  err: process.stderr,
  muximod: worktreeProfile
    ? { schemaMode: "push", baseInstanceDir: worktreeProfile.baseInstanceDir }
    : { schemaMode: "migrate" },
});
process.exitCode = status;

function configureDevelopmentWorktreeEnvironment(
  environment: NodeJS.ProcessEnv,
  repositoryRoot: string,
): { baseInstanceDir: string } | undefined {
  let worktreeRoot: string;
  try {
    const gitDirectory = realpathSync(
      execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--absolute-git-dir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    const commonGitDirectory = realpathSync(
      execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--git-common-dir"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    if (gitDirectory === commonGitDirectory) return undefined;
    worktreeRoot = realpathSync(
      execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return undefined;
  }

  const id = createHash("sha256").update(worktreeRoot).digest("hex").slice(0, 16);
  environment.MUXIMO_WORKTREE_ID = id;
  const stateRoot = resolve(environment.MUXIMO_DEV_STATE_ROOT ?? defaultMuximodInstanceDirectory(environment));
  environment.MUXIMOD_INSTANCE_DIR = join(stateRoot, "worktrees", id);
  return { baseInstanceDir: stateRoot };
}
