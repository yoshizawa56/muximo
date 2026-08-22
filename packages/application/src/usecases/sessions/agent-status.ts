import type { PaneState } from "@muximo/domain";

export const recentAgentOutputLimits = {
  maxCharacters: 1_200,
} as const;

export type AgentStatusObservation = {
  state: PaneState;
  recentOutput?: string;
};

export type AgentStatusStore = Map<string, AgentStatusObservation>;

export function agentStatusKey(agentSessionId: string, executionId: string): string {
  return `${agentSessionId}:${executionId}`;
}

/**
 * Managed executions must use the provider observation or this neutral
 * lifecycle fallback. Persisted pane state is intentionally not reused here,
 * because it may belong to an earlier execution.
 */
export function readManagedAgentObservation(
  agentSessionId: string,
  executionId: string,
  agentStatus: AgentStatusStore,
): AgentStatusObservation {
  return agentStatus.get(agentStatusKey(agentSessionId, executionId)) ?? { state: "running" };
}

/**
 * Compatibility fallback for agent processes that were not launched through
 * the managed plugin path. This parser must never be used for an adopted
 * managed execution.
 */
export function inferUnmanagedAgentState(output: string, fallback: PaneState): PaneState {
  const recent = stripAnsi(output).slice(-8_000).toLowerCase();
  if (/waiting\s+(for\s+)?(approval|permission)|approve|allow this|apply this|do you want/.test(recent)) return "waiting_approval";
  if (/waiting\s+(for\s+)?input|continue with|press (enter|return)|what should i do|\?\s*[▌_>]?\s*$/.test(recent)) return "waiting_input";
  return recent ? "running" : fallback;
}

export function normalizeAgentStatusObservation(observation: AgentStatusObservation): AgentStatusObservation {
  const recentOutput = observation.recentOutput?.trim();
  if (!recentOutput) return { state: observation.state };
  return {
    state: observation.state,
    recentOutput: recentOutput.length <= recentAgentOutputLimits.maxCharacters
      ? recentOutput
      : `…${recentOutput.slice(-(recentAgentOutputLimits.maxCharacters - 1))}`,
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}
