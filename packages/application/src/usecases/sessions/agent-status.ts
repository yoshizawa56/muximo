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
 * Managed executions use the in-memory provider observation first. A persisted
 * observation may be supplied only after the caller has verified that it
 * belongs to the current execution.
 */
export function readManagedAgentObservation(
  agentSessionId: string,
  executionId: string,
  agentStatus: AgentStatusStore,
  persisted?: AgentStatusObservation,
): AgentStatusObservation {
  const current = agentStatus.get(agentStatusKey(agentSessionId, executionId));
  if (!current) return persisted ?? { state: "running" };
  if (current.recentOutput === undefined && persisted?.recentOutput !== undefined) {
    return { ...current, recentOutput: persisted.recentOutput };
  }
  return current;
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
