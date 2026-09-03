import type { AgentSession } from "@muximo/domain";
import { resolveExecutable } from "../launch.js";

export function resolveClaudeCommand(environment: NodeJS.ProcessEnv): string {
  return resolveExecutable(environment.MUXIMO_CLAUDE_BIN ?? "claude", environment);
}

export function buildClaudeRunCommand(session: AgentSession, backendArgs: readonly string[], binary: string): string[] {
  const args = [binary];
  if (!hasOption("--name", backendArgs) && !hasOption("-n", backendArgs)) args.push("--name", session.name);
  if (!hasOption("--session-id", backendArgs)) args.push("--session-id", session.backendSessionId ?? "");
  if (!hasOption("--permission-mode", backendArgs) && !hasOption("--dangerously-skip-permissions", backendArgs)) {
    args.push("--permission-mode", "auto");
  }
  args.push(...backendArgs);
  return args;
}

export function buildClaudeResumeCommand(
  session: AgentSession,
  backendArgs: readonly string[],
  binary: string,
): string[] {
  if (!session.backendSessionId) throw new Error("backend session ID is required to resume");
  return [binary, "--resume", session.backendSessionId, ...backendArgs];
}

function hasOption(name: string, args: readonly string[]): boolean {
  return args.some((argument) => argument === name || argument.startsWith(`${name}=`));
}
