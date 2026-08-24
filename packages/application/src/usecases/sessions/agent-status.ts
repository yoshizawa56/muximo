import type { PaneState } from "@muximo/domain";

export const recentAgentOutputLimits = {
  maxCharacters: 1_200,
} as const;

export type AgentStatusObservation = {
  state: PaneState;
  recentOutput?: string;
};

export interface AgentStatusStore {
  get(key: string): AgentStatusObservation | undefined;
  set(key: string, observation: AgentStatusObservation): void;
  delete(key: string): boolean;
}

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

export function normalizeAgentStatusObservation(observation: AgentStatusObservation): AgentStatusObservation {
  const recentOutput = observation.recentOutput?.trim();
  if (!recentOutput) return { state: observation.state };
  return {
    state: observation.state,
    recentOutput:
      recentOutput.length <= recentAgentOutputLimits.maxCharacters
        ? recentOutput
        : `…${recentOutput.slice(-(recentAgentOutputLimits.maxCharacters - 1))}`,
  };
}
