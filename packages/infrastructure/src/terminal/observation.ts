import type { MuximodPaneClassification, MuximodPaneObservation } from "@muximo/application";
import type { PaneState } from "@muximo/domain";

const shellExecutables = new Set(["zsh", "bash", "fish", "sh"]);
const agentExecutables = new Set(["agent", "codex", "claude", "aider", "opencode", "gemini"]);

export function classifyTerminalCommand(command: string): MuximodPaneClassification {
  const executable = executableName(command);
  if (!executable || shellExecutables.has(executable)) return { kind: "shell" };
  if (agentExecutables.has(executable)) return { kind: "agent", agentId: executable };
  return { kind: "unknown" };
}

/**
 * Classifies output from an unmanaged agent process at the terminal boundary.
 * Application code receives only the resulting neutral state.
 */
export function classifyUnmanagedAgentOutput(output: string, fallback: PaneState): MuximodPaneObservation {
  const recent = stripAnsi(output).slice(-8_000).toLowerCase();
  if (/waiting\s+(for\s+)?(approval|permission)|approve|allow this|apply this|do you want/.test(recent)) {
    return { state: "waiting_approval" };
  }
  if (/waiting\s+(for\s+)?input|continue with|press (enter|return)|what should i do|\?\s*[▌_>]?\s*$/.test(recent)) {
    return { state: "waiting_input" };
  }
  return { state: recent ? "running" : fallback };
}

export function executableName(command: string): string {
  return command.trim().toLowerCase().split(/\s+/, 1)[0]?.split("/").at(-1) ?? "";
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}
