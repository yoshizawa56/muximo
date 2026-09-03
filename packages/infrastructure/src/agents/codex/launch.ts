import { spawnSync } from "node:child_process";
import { basename } from "node:path";
import type { AgentSession } from "@muximo/domain";
import type { Logger } from "../../logging/index.js";
import { resolveExecutable } from "../launch.js";
import type { CodexSessionState } from "./state.js";

export function resolveCodexCommand(environment: NodeJS.ProcessEnv): string {
  return resolveExecutable(environment.MUXIMO_CODEX_BIN ?? "codex", environment);
}

export function buildCodexRunCommand(
  session: AgentSession,
  backendArgs: readonly string[],
  defaultRemote: string,
  backendBinary: string,
  state: CodexSessionState,
): string[] {
  const args = [backendBinary];
  if (state.profile && !hasOption("--profile", backendArgs) && !hasOption("-p", backendArgs)) {
    args.push("--profile", state.profile);
  }
  const remote = state.remote ?? codexRemoteEndpoint(backendArgs, defaultRemote);
  if (remote && !hasOption("--remote", backendArgs)) args.push("--remote", remote);
  const runDir = session.worktreePath ?? session.workspaceRoot;
  if (remote && !hasOption("--cd", backendArgs) && !hasOption("-C", backendArgs)) args.push("--cd", runDir);
  args.push(...backendArgs);
  return args;
}

export function buildCodexResumeCommand(
  session: AgentSession,
  backendArgs: readonly string[],
  defaultRemote: string,
  backendBinary: string,
  state: CodexSessionState,
): string[] {
  if (!session.backendSessionId) throw new Error("backend session ID is required to resume");
  const full = buildCodexRunCommand(session, backendArgs, defaultRemote, backendBinary, state);
  const backendStart = full.length - backendArgs.length;
  return [...full.slice(0, backendStart), "resume", session.backendSessionId, ...backendArgs];
}

export function codexRemoteEndpoint(args: readonly string[], fallback: string): string {
  return optionValue("--remote", args) ?? fallback;
}

/** Starts the Codex app-server remote-control daemon when a remote is active. */
export function ensureCodexRemoteControl(
  args: readonly string[],
  binary: string,
  defaultRemote: string,
  environment: NodeJS.ProcessEnv,
  logger?: Pick<Logger, "debug">,
): void {
  if (!codexRemoteEndpoint(args, defaultRemote)) return;
  logger?.debug("codex.remote_control_starting", {
    executable: basename(binary),
    remoteConfigured: true,
  });
  for (const command of [
    ["app-server", "daemon", "enable-remote-control"],
    ["app-server", "daemon", "start"],
  ]) {
    const startedAt = Date.now();
    logger?.debug("codex.remote_control_command_started", {
      executable: basename(binary),
      operation: command.join("."),
    });
    const result = spawnSync(binary, command, { stdio: "ignore", env: environment });
    logger?.debug("codex.remote_control_command_finished", {
      executable: basename(binary),
      operation: command.join("."),
      exitCode: result.status,
      signal: result.signal,
      durationMs: Date.now() - startedAt,
    });
    if (result.status !== 0) {
      logger?.debug("codex.remote_control_failed", {
        executable: basename(binary),
        operation: command.join("."),
        exitCode: result.status,
      });
      throw new Error(`could not run Codex app-server command: ${command.join(" ")}`);
    }
  }
  logger?.debug("codex.remote_control_finished", { executable: basename(binary) });
}

function hasOption(name: string, args: readonly string[]): boolean {
  return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}

function optionValue(name: string, args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (argument.startsWith(`${name}=`)) return argument.slice(name.length + 1);
    if (argument === name) return args[index + 1];
  }
  return undefined;
}
