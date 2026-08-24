import { AgentSession, type AgentSessionRecord, type AgentSessionUpdateInput } from "@muximo/domain";
import type { SessionClock } from "../../ports/agent-sessions.js";

export function updateAgentSession(
  session: AgentSessionRecord,
  input: AgentSessionUpdateInput,
  clock: SessionClock,
): AgentSessionRecord {
  return AgentSession.update(session, { ...input, updatedAt: clock.now() });
}

export function applyAdapterUpdate(
  session: AgentSessionRecord,
  input: AgentSessionUpdateInput | undefined,
  clock: SessionClock,
): AgentSessionRecord {
  return input === undefined ? session : updateAgentSession(session, input, clock);
}
