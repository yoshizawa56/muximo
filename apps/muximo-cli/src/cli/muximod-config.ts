import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { MuximodRuntimeEnvironment } from "@muximo/muximod/client";
import type { MuximoCliRuntimeOptions } from "./runtime-types.js";

export type MuximodRuntimeEnvironmentOptions = {
  environment: NodeJS.ProcessEnv;
  workingDirectory: string;
  runtime: MuximoCliRuntimeOptions;
};

/**
 * Captures host context for the daemon process. Durable daemon settings are
 * intentionally absent; muximod reads those from the instance contract after
 * it starts.
 */
export function createMuximodRuntimeEnvironment(options: MuximodRuntimeEnvironmentOptions): MuximodRuntimeEnvironment {
  const workingDirectory = resolve(options.workingDirectory);
  return {
    homeDirectory: readEnvironmentValue(options.environment.HOME),
    path: readEnvironmentValue(options.environment.PATH),
    codexHome: readEnvironmentValue(options.environment.CODEX_HOME),
    claudeConfigDirectory: readEnvironmentValue(options.environment.CLAUDE_CONFIG_DIR),
    // Executable selection is instance configuration. Clearing these values
    // prevents inherited environment variables from competing with it.
    tailscaleBinary: null,
    tmuxPane: readEnvironmentValue(options.environment.TMUX_PANE),
    tmuxSocket: readEnvironmentValue(options.environment.MUXIMOD_TMUX_SOCKET),
    worktreeId: readEnvironmentValue(options.environment.MUXIMO_WORKTREE_ID),
    worktreeRoot: readEnvironmentValue(options.environment.MUXIMO_WORKTREE_ROOT),
    muximoCommand: readEnvironmentValue(options.environment.MUXIMOD_MUXIMO_COMMAND),
    // The daemon replaces this bootstrap placeholder with agents.codexRemote
    // after it reads the instance configuration.
    codexRemote: "unix://",
    codexBinary: null,
    claudeBinary: null,
    opencodeBinary: null,
    migrationsDirectory: options.environment.MUXIMOD_MIGRATIONS_DIR
      ? resolveConfiguredPath(options.environment.MUXIMOD_MIGRATIONS_DIR, workingDirectory)
      : null,
  };
}

function readEnvironmentValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized || null;
}

function resolveConfiguredPath(value: string, baseDirectory: string, homeDirectory = homedir()): string {
  const expanded =
    value === "~" ? homeDirectory : value.startsWith("~/") ? resolve(homeDirectory, value.slice(2)) : value;
  return resolve(isAbsolute(expanded) ? expanded : resolve(baseDirectory, expanded));
}
