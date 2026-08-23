import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { commandPath } from "../command-support.js";

export type DoctorDeps = {
  env: NodeJS.ProcessEnv;
  logger: { child(fields: Record<string, unknown>): { debug(event: string, fields?: Record<string, unknown>): void } };
  write(text: string, error?: boolean): void;
  databaseFile: string;
  defaultCodexRemote: string;
};
export async function runDoctor(options: { verbose: boolean }, deps: DoctorDeps): Promise<number> {
  const logger = deps.logger.child({ command: "doctor" });
  const startedAt = Date.now();
  logger.debug("doctor.started", { verbose: options.verbose });
  let status = 0;
  for (const command of ["git", "zsh", "codex", "claude", "opencode"]) {
    const path = commandPath(command, deps.env);
    logger.debug("doctor.command_checked", { command, available: Boolean(path) });
    if (path) deps.write(`${command}: ${path}\n`);
    else {
      deps.write(`${command}: missing\n`, true);
      status = 1;
    }
  }
  const configuredProfile = deps.env.MUXIMO_CODEX_PROFILE || null;
  if (configuredProfile) {
    const profilePath = join(deps.env.CODEX_HOME ?? join(homedir(), ".codex"), `${configuredProfile}.config.toml`);
    if (existsSync(profilePath)) {
      deps.write(`codex profile: ${profilePath}\n`);
      const codex = commandPath("codex", deps.env);
      const validationStartedAt = Date.now();
      const validation = codex
        ? spawnSync(codex, ["--profile", configuredProfile, "--strict-config", "--help"], {
            stdio: "ignore",
            env: deps.env,
          })
        : undefined;
      logger.debug("doctor.codex_profile_checked", {
        available: Boolean(codex),
        exitCode: validation?.status ?? null,
        durationMs: Date.now() - validationStartedAt,
      });
      if (codex && validation?.status !== 0) {
        deps.write("codex profile validation: failed\n", true);
        status = 1;
      } else deps.write("codex profile validation: ok\n");
    } else {
      deps.write(`codex profile: missing (${profilePath})\n`, true);
      status = 1;
    }
  } else {
    deps.write("codex profile: not configured\n");
  }
  const mise = commandPath("mise", deps.env);
  deps.write(mise ? `mise: ${mise}\n` : "mise: unavailable (not required for workspace hooks)\n");
  if (options.verbose) {
    deps.write(`database: ${deps.databaseFile}\n`);
    deps.write(`codex remote: ${deps.defaultCodexRemote || "native local mode"}\n`);
    deps.write(
      `worktree root pattern: <workspace-parent>/<workspace-name>.worktrees${deps.env.MUXIMO_WORKTREE_ID ? `/${deps.env.MUXIMO_WORKTREE_ID}` : ""}/<session-name>\n`,
    );
  }
  logger.debug("doctor.finished", { status, durationMs: Date.now() - startedAt });
  return status;
}
