import type { AgentSession, AgentSessionUpdateInput } from "@muximo/domain";
import { Effect } from "effect";
import { attemptSync } from "../../attempt.js";
import type { SessionClock } from "../../ports/agent-sessions.js";
import { ApplicationFailure } from "../../ports/application.js";

export function updateAgentSession(
  session: AgentSession,
  input: AgentSessionUpdateInput,
  clock: SessionClock,
): Effect.Effect<AgentSession, Error> {
  return attemptSync(() => session.update({ ...input, lastActivityAt: clock.now() }));
}

/** Fails with the abort reason when the caller's signal was already aborted. */
export const checkAborted = (signal: AbortSignal | undefined): Effect.Effect<void, Error> =>
  signal?.aborted
    ? Effect.fail(
        signal.reason instanceof Error
          ? signal.reason
          : new ApplicationFailure(
              "agent_execution_preparation_cancelled",
              "agent execution preparation was cancelled",
            ),
      )
    : Effect.succeed(undefined);
