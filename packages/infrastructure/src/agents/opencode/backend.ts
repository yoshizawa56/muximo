import type { SessionBaselineResult, SessionIdentityUpdate } from "@muximo/application";
import type { AgentSession } from "@muximo/domain";
import { timestamp } from "../../cli/filesystem.js";
import { stringEnvironment } from "../../process/process.js";
import type {
  AgentBackendLaunch,
  AgentBackendProvider,
  AgentBackendProviderOptions,
  AgentBackendProviderPreparation,
} from "../backend.js";
import { buildOpenCodeResumeCommand, buildOpenCodeRunCommand, resolveOpenCodeCommand } from "./launch.js";
import { openCodeMonitorActions } from "./monitor.js";

export class OpenCodeBackendProvider implements AgentBackendProvider {
  public readonly backend = "opencode" as const;

  public constructor(private readonly options: AgentBackendProviderOptions) {}

  public async captureBaseline(_session: AgentSession): Promise<SessionBaselineResult> {
    return { success: true };
  }

  public async prepareLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    signal?: AbortSignal,
  ): Promise<AgentBackendProviderPreparation> {
    const plugin = this.options.plugins.get(this.backend);
    const launch = plugin?.prepareLaunch
      ? await this.preparePluginLaunch(session, backendArgs, plugin.prepareLaunch, resume, signal)
      : this.prepareCommandLaunch(session, backendArgs, resume);
    let sessionUpdate: SessionIdentityUpdate | undefined;
    if (launch.backendSessionId && !session.backendSessionId) {
      sessionUpdate = { backendSessionId: launch.backendSessionId };
    }
    return { sessionUpdate, launch };
  }

  public async restoreLaunch(session: AgentSession): Promise<AgentBackendLaunch | undefined> {
    const plugin = this.options.plugins.get(this.backend);
    if (!plugin?.prepareLaunch || !session.backendSessionId) return undefined;
    return this.preparePluginLaunch(session, [], plugin.prepareLaunch, true, undefined, session.executionStartedAt);
  }

  public async afterRun(
    _session: AgentSession,
    _runDir: string,
    _startedAt: number,
  ): Promise<SessionIdentityUpdate | undefined> {
    return undefined;
  }

  public async disposeLaunch(_session: AgentSession, _runDir: string): Promise<void> {
    // OpenCode servers are shared service references. Releasing a session must
    // never terminate a server that may be used by another daemon or client.
  }

  public async archive(_session: AgentSession): Promise<boolean> {
    return true;
  }

  public async restore(_session: AgentSession): Promise<boolean> {
    return true;
  }

  public async releaseIfUnused(_session: AgentSession, _remaining: readonly AgentSession[]): Promise<void> {
    // OpenCode server lifetime is independent from agent-session cleanup.
  }

  private async preparePluginLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    prepare: NonNullable<NonNullable<import("../index.js").AgentPluginV1["prepareLaunch"]>>,
    resume: boolean,
    signal?: AbortSignal,
    startedAt = timestamp(),
  ): Promise<AgentBackendLaunch> {
    signal?.throwIfAborted();
    const runDir = session.worktreePath ?? session.workspaceRoot;
    const plan = await prepare({
      cwd: runDir,
      args: [...backendArgs],
      environment: stringEnvironment(this.options.environment),
      name: session.name,
      monitorContext: {
        sessionId: session.id,
        executionId: session.executionId ?? "",
        cwd: runDir,
        startedAt,
        backendSessionId: session.backendSessionId ?? null,
        environment: this.options.environment,
      },
      resumeSessionId: resume ? (session.backendSessionId ?? null) : null,
      signal,
    });
    return {
      command: [plan.primary.command, ...plan.primary.args],
      monitor: plan.monitor,
      backendSessionId: plan.backendSessionId ?? null,
      abortSession: plan.monitor?.execute
        ? async () => plan.monitor?.execute?.({ ...openCodeMonitorActions.abort })
        : undefined,
      dispose: plan.dispose ?? (async () => undefined),
    };
  }

  private prepareCommandLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
  ): AgentBackendLaunch {
    const binary = resolveOpenCodeCommand(this.options.environment);
    return {
      command: resume
        ? buildOpenCodeResumeCommand(session, backendArgs, binary)
        : buildOpenCodeRunCommand(session, backendArgs, binary),
    };
  }
}
