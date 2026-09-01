import { randomUUID } from "node:crypto";
import type { SessionBaselineResult, SessionIdentityUpdate } from "@muximo/application";
import { AgentSession, type AgentSessionRecord } from "@muximo/domain";
import type { AgentBackendProvider, AgentBackendProviderOptions, AgentBackendProviderPreparation } from "../backend.js";
import { buildClaudeResumeCommand, buildClaudeRunCommand, resolveClaudeCommand } from "./launch.js";

export class ClaudeBackendProvider implements AgentBackendProvider {
  public readonly backend = "claude" as const;

  public constructor(private readonly options: AgentBackendProviderOptions) {}

  public async captureBaseline(_session: AgentSessionRecord): Promise<SessionBaselineResult> {
    return { success: true };
  }

  public async prepareLaunch(
    session: AgentSessionRecord,
    backendArgs: readonly string[],
    resume: boolean,
    _signal?: AbortSignal,
  ): Promise<AgentBackendProviderPreparation> {
    let effective = session;
    let sessionUpdate: SessionIdentityUpdate | undefined;
    if (!resume && !session.backendSessionId) {
      sessionUpdate = { backendSessionId: randomUUID() };
      effective = this.update(effective, sessionUpdate);
    }
    const binary = resolveClaudeCommand(this.options.environment);
    const command = resume
      ? buildClaudeResumeCommand(effective, backendArgs, binary)
      : buildClaudeRunCommand(effective, backendArgs, binary);
    return { sessionUpdate, launch: { command } };
  }

  public async afterRun(
    _session: AgentSessionRecord,
    _runDir: string,
    _startedAt: number,
  ): Promise<SessionIdentityUpdate | undefined> {
    return undefined;
  }

  public async disposeLaunch(_session: AgentSessionRecord, _runDir: string): Promise<void> {}

  public async archive(_session: AgentSessionRecord): Promise<boolean> {
    return true;
  }

  public async restore(_session: AgentSessionRecord): Promise<boolean> {
    return true;
  }

  public async releaseIfUnused(
    _session: AgentSessionRecord,
    _remaining: readonly AgentSessionRecord[],
  ): Promise<void> {}

  private update(session: AgentSessionRecord, input: SessionIdentityUpdate): AgentSessionRecord {
    return AgentSession.update(session, input);
  }
}
