#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createPushSchemaSynchronizer } from "@muximo/infrastructure";
import { configurePortlessService, loadDevelopmentEnvironment, resolveRepositoryRoot } from "@muximo/portless-support";
import { ensureDevMuximodState } from "./src/dev-state.js";
import { runMuximod } from "./src/entrypoint.js";

const repositoryRoot = resolveRepositoryRoot();
loadDevelopmentEnvironment({ repositoryRoot });
configureDevelopmentWorktreeEnvironment(process.env, repositoryRoot);
configurePortlessService("muximod", { repositoryRoot });

await ensureDevMuximodState(process.env);
await runMuximod({
  schemaSynchronizer: createPushSchemaSynchronizer({ force: true }),
});

function configureDevelopmentWorktreeEnvironment(environment: NodeJS.ProcessEnv, repositoryRoot: string): void {
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
    if (gitDirectory === commonGitDirectory) return;
    worktreeRoot = realpathSync(
      execFileSync("git", ["-C", repositoryRoot, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return;
  }

  const id = createHash("sha256").update(worktreeRoot).digest("hex").slice(0, 16);
  environment.MUXIMO_WORKTREE_ID = id;
  const stateRoot = resolve(join(environment.HOME ?? homedir(), ".local", "state", "muximo"));
  environment.MUXIMOD_INSTANCE_DIR = join(stateRoot, "worktrees", id);
}
