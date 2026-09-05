import type { ApplicationEffect } from "@muximo/application";
import { attemptSync } from "@muximo/application";
import type { AgentSessionId } from "@muximo/domain";
import { eq } from "drizzle-orm";
import type { AgentDrizzleDatabase } from "../../persistence/database-types.js";
import { codexSessionStates } from "../../persistence/schema.js";

export type CodexSessionState = {
  profile?: string;
  remote?: string;
  sessionBaseline?: string;
};

export interface CodexSessionStateRepository {
  find(sessionId: AgentSessionId): ApplicationEffect<CodexSessionState | undefined>;
  save(sessionId: AgentSessionId, state: CodexSessionState, updatedAt: string): ApplicationEffect<void>;
  delete(sessionId: AgentSessionId): ApplicationEffect<void>;
}

/** SQLite adapter for Codex-only implementation metadata. */
export class DrizzleCodexSessionStateRepository implements CodexSessionStateRepository {
  public constructor(private readonly database: AgentDrizzleDatabase) {}

  public find(sessionId: AgentSessionId): ApplicationEffect<CodexSessionState | undefined> {
    return attemptSync(() => {
      const row = this.database
        .select()
        .from(codexSessionStates)
        .where(eq(codexSessionStates.agentSessionId, sessionId))
        .get();
      if (!row) return undefined;
      return {
        ...(row.profile === null ? {} : { profile: row.profile }),
        ...(row.remote === null ? {} : { remote: row.remote }),
        ...(row.sessionBaseline === null ? {} : { sessionBaseline: row.sessionBaseline }),
      };
    });
  }

  public save(sessionId: AgentSessionId, state: CodexSessionState, updatedAt: string): ApplicationEffect<void> {
    return attemptSync(() => {
      this.database
        .insert(codexSessionStates)
        .values({
          agentSessionId: sessionId,
          profile: state.profile ?? null,
          remote: state.remote ?? null,
          sessionBaseline: state.sessionBaseline ?? null,
          createdAt: updatedAt,
          updatedAt,
        })
        .onConflictDoUpdate({
          target: codexSessionStates.agentSessionId,
          set: {
            profile: state.profile ?? null,
            remote: state.remote ?? null,
            sessionBaseline: state.sessionBaseline ?? null,
            updatedAt,
          },
        })
        .run();
    });
  }

  public delete(sessionId: AgentSessionId): ApplicationEffect<void> {
    return attemptSync(() => {
      this.database.delete(codexSessionStates).where(eq(codexSessionStates.agentSessionId, sessionId)).run();
    });
  }
}
