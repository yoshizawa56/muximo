import { AgentSession } from "@muximo/domain";
import { Effect } from "effect";
import type { WorkspaceScope } from "../../ports/agent-sessions.js";
import { ApplicationFailure } from "../../ports/application.js";
import { ManagedAgentSessionRepositoryService, WorkspaceResolverService } from "./agent-session-services.js";

export type LocateAgentSessionInput = {
  reference: string;
  workspaceScope: WorkspaceScope;
};

/** Resolves a workspace/name reference without touching host APIs. */
export class LocateAgentSession {
  public readonly execute = Effect.fn("AgentSessions.locate")(
    { self: this },
    function* (this: LocateAgentSession, input: LocateAgentSessionInput) {
      const sessionsRepository = yield* ManagedAgentSessionRepositoryService;
      const workspace = yield* WorkspaceResolverService;
      const separatorIndex = input.reference.indexOf("/");
      if (input.workspaceScope === "current" && separatorIndex >= 0) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "session_reference_requires_all_scope",
            `workspace-qualified session references require all-workspace scope: ${input.reference}`,
          ),
        );
      }
      const selector = separatorIndex >= 0 ? input.reference.slice(0, separatorIndex) : undefined;
      const requestedName = separatorIndex >= 0 ? input.reference.slice(separatorIndex + 1) : input.reference;
      if (requestedName.includes("/"))
        return yield* Effect.fail(
          new ApplicationFailure("invalid_session_reference", `invalid session reference: ${input.reference}`),
        );

      const sessions = yield* sessionsRepository.list(
        input.workspaceScope === "all" ? undefined : (yield* workspace.resolveCurrent()).id,
      );
      const scoped = sessions.filter(
        (session) => !selector || session.workspaceId === selector || session.workspaceName === selector,
      );
      const exactMatches = scoped.filter((session) => session.name === requestedName);
      const exactMatch = exactMatches[0];
      if (exactMatches.length === 1 && exactMatch) return exactMatch;
      if (exactMatches.length > 1) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "ambiguous_session_name",
            `${input.workspaceScope === "all" ? "global " : ""}session name is ambiguous; use WORKSPACE/${requestedName}`,
          ),
        );
      }

      const normalizedName = yield* normalizeSessionName(requestedName);
      const matches = scoped.filter((session) => session.name === normalizedName);
      if (matches.length === 0) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "session_not_found",
            input.workspaceScope === "all"
              ? `global session not found: ${input.reference}`
              : `session not found in this workspace: ${input.reference}`,
          ),
        );
      }
      if (matches.length > 1) {
        return yield* Effect.fail(
          new ApplicationFailure(
            "ambiguous_session_name",
            `${input.workspaceScope === "all" ? "global " : ""}session name is ambiguous; use WORKSPACE/${normalizedName}`,
          ),
        );
      }
      const match = matches[0];
      if (!match)
        return yield* Effect.fail(new ApplicationFailure("session_not_found", `session not found: ${input.reference}`));
      return match;
    },
  );
}

function normalizeSessionName(value: string): Effect.Effect<string, ApplicationFailure> {
  return Effect.suspend(() => {
    try {
      return Effect.succeed(AgentSession.normalizeName(value));
    } catch (error) {
      return Effect.fail(
        new ApplicationFailure("invalid_agent_session_name", error instanceof Error ? error.message : String(error)),
      );
    }
  });
}
