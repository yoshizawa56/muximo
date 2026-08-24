import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DoctorCommandCheck = {
  command: string;
  path?: string;
  required: boolean;
};

export type DoctorProfileCheck = {
  profile: string | null;
  path?: string;
  state: "not-configured" | "missing" | "valid" | "invalid";
};

export type DoctorReport = {
  status: 0 | 1;
  commands: readonly DoctorCommandCheck[];
  codexProfile: DoctorProfileCheck;
  mise: { path?: string };
  details?: {
    databaseFile: string;
    defaultRemote: string;
    worktreeRootPattern: string;
  };
};

export type DoctorServiceOptions = {
  environment: NodeJS.ProcessEnv;
  databaseFile: string;
  defaultRemote: string;
  logger: { child(fields: Record<string, unknown>): { debug(event: string, fields?: Record<string, unknown>): void } };
};

/** Returns typed local diagnostics; presentation remains in the CLI layer. */
export function runDoctor(options: { verbose: boolean }, deps: DoctorServiceOptions): DoctorReport {
  const logger = deps.logger.child({ command: "doctor" });
  const startedAt = Date.now();
  logger.debug("doctor.started", { verbose: options.verbose });
  const commands = ["git", "zsh", "codex", "claude", "opencode"].map((command) => ({
    command,
    path: commandPath(command, deps.environment),
    required: true,
  }));
  const profile = inspectCodexProfile(deps.environment, commands.find((check) => check.command === "codex")?.path);
  const mise = { path: commandPath("mise", deps.environment) };
  const status =
    commands.some((check) => check.path === undefined) || profile.state === "missing" || profile.state === "invalid"
      ? 1
      : 0;
  const report: DoctorReport = {
    status: status as 0 | 1,
    commands,
    codexProfile: profile,
    mise,
    ...(options.verbose
      ? {
          details: {
            databaseFile: deps.databaseFile,
            defaultRemote: deps.defaultRemote,
            worktreeRootPattern: `<workspace-parent>/<workspace-name>.worktrees${deps.environment.MUXIMO_WORKTREE_ID ? `/${deps.environment.MUXIMO_WORKTREE_ID}` : ""}/<session-name>`,
          },
        }
      : {}),
  };
  logger.debug("doctor.finished", { status, durationMs: Date.now() - startedAt });
  return report;
}

function inspectCodexProfile(environment: NodeJS.ProcessEnv, codexPath: string | undefined): DoctorProfileCheck {
  const profile = environment.MUXIMO_CODEX_PROFILE || null;
  if (!profile) return { profile: null, state: "not-configured" };
  const path = join(environment.CODEX_HOME ?? join(homedir(), ".codex"), `${profile}.config.toml`);
  if (!existsSync(path)) return { profile, path, state: "missing" };
  if (!codexPath) return { profile, path, state: "invalid" };
  const validation = spawnSync(codexPath, ["--profile", profile, "--strict-config", "--help"], {
    stdio: "ignore",
    env: environment,
  });
  return { profile, path, state: validation.status === 0 ? "valid" : "invalid" };
}

function commandPath(command: string, environment: NodeJS.ProcessEnv): string | undefined {
  for (const directory of (environment.PATH ?? "").split(":")) {
    const path = `${directory}/${command}`;
    if (existsSync(path)) return path;
  }
  return undefined;
}
