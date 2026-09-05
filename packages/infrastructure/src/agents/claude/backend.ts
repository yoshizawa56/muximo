import { randomUUID } from "node:crypto";
import {
  type ApplicationEffect,
  attemptSync,
  type SessionBaselineResult,
  type SessionIdentityUpdate,
} from "@muximo/application";
import type { AgentSession } from "@muximo/domain";
import { Effect } from "effect";
import type { AgentBackendProvider, AgentBackendProviderOptions, AgentBackendProviderPreparation } from "../backend.js";
import { buildClaudeResumeCommand, buildClaudeRunCommand, resolveClaudeCommand } from "./launch.js";

export class ClaudeBackendProvider implements AgentBackendProvider {
  public readonly backend = "claude" as const;

  public constructor(private readonly options: AgentBackendProviderOptions) {}

  public captureBaseline(_session: AgentSession): ApplicationEffect<SessionBaselineResult> {
    return Effect.succeed({ success: true });
  }

  public prepareLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    _signal?: AbortSignal,
  ): ApplicationEffect<AgentBackendProviderPreparation> {
    const environment = this.options.environment;
    return Effect.gen(function* () {
      let effective = session;
      let sessionUpdate: SessionIdentityUpdate | undefined;
      if (!resume && !session.backendSessionId) {
        const update = { backendSessionId: randomUUID() } satisfies SessionIdentityUpdate;
        sessionUpdate = update;
        effective = yield* attemptSync(() => effective.update(update));
      }
      const binary = yield* attemptSync(() => resolveClaudeCommand(environment));
      const command = resume
        ? buildClaudeResumeCommand(effective, backendArgs, binary)
        : buildClaudeRunCommand(effective, backendArgs, binary);
      return { sessionUpdate, launch: { command } };
    });
  }

  public afterRun(
    _session: AgentSession,
    _runDir: string,
    _startedAt: number,
  ): ApplicationEffect<SessionIdentityUpdate | undefined> {
    return Effect.succeed(undefined);
  }

  public disposeLaunch(_session: AgentSession, _runDir: string): ApplicationEffect<void> {
    return Effect.succeed(undefined);
  }

  public archive(_session: AgentSession): ApplicationEffect<boolean> {
    return Effect.succeed(true);
  }

  public restore(_session: AgentSession): ApplicationEffect<boolean> {
    return Effect.succeed(true);
  }

  public releaseIfUnused(_session: AgentSession, _remaining: readonly AgentSession[]): ApplicationEffect<void> {
    return Effect.succeed(undefined);
  }
}
