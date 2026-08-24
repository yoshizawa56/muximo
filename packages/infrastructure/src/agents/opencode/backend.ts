import type { SessionBaselineResult, SessionIdentityUpdate } from "@muximo/application";
import type { AgentSessionRecord } from "@muximo/domain";
import { timestamp } from "../../cli/filesystem.js";
import { errorFields } from "../../logging/index.js";
import { stringEnvironment } from "../../process/process.js";
import type {
  AgentBackendLaunch,
  AgentBackendProvider,
  AgentBackendProviderOptions,
  AgentBackendProviderPreparation,
} from "../backend.js";
import { buildOpenCodeResumeCommand, buildOpenCodeRunCommand, resolveOpenCodeCommand } from "./launch.js";
import { openCodeMonitorActions } from "./monitor.js";
import { defaultOpenCodeRegistryFile, OpenCodeServerManager } from "./server.js";

export class OpenCodeBackendProvider implements AgentBackendProvider {
  public readonly backend = "opencode" as const;

  public constructor(private readonly options: AgentBackendProviderOptions) {}

  public async captureBaseline(_session: AgentSessionRecord): Promise<SessionBaselineResult> {
    return { success: true };
  }

  public async prepareLaunch(
    session: AgentSessionRecord,
    backendArgs: readonly string[],
    resume: boolean,
  ): Promise<AgentBackendProviderPreparation> {
    const plugin = this.options.plugins.get(this.backend);
    const launch = plugin?.prepareLaunch
      ? await this.preparePluginLaunch(session, backendArgs, plugin.prepareLaunch, resume)
      : this.prepareCommandLaunch(session, backendArgs, resume);
    let sessionUpdate: SessionIdentityUpdate | undefined;
    if (launch.backendSessionId && !session.backendSessionId) {
      sessionUpdate = { backendSessionId: launch.backendSessionId };
    }
    return { sessionUpdate, launch };
  }

  public async afterRun(
    _session: AgentSessionRecord,
    _runDir: string,
    _startedAt: number,
  ): Promise<SessionIdentityUpdate | undefined> {
    return undefined;
  }

  public async archive(_session: AgentSessionRecord): Promise<boolean> {
    return true;
  }

  public async restore(_session: AgentSessionRecord): Promise<boolean> {
    return true;
  }

  public async releaseIfUnused(session: AgentSessionRecord, remaining: readonly AgentSessionRecord[]): Promise<void> {
    const runDir = session.worktreePath ?? session.workspaceRoot;
    if (
      remaining.some(
        (candidate) =>
          candidate.backend === this.backend && (candidate.worktreePath ?? candidate.workspaceRoot) === runDir,
      )
    ) {
      return;
    }
    try {
      await new OpenCodeServerManager({
        registryFile: defaultOpenCodeRegistryFile(this.options.environment),
      }).dispose(runDir);
    } catch (error) {
      this.options.logger.warn("opencode.server_release_failed", { runDir, ...errorFields(error) });
      throw error;
    }
  }

  private async preparePluginLaunch(
    session: AgentSessionRecord,
    backendArgs: readonly string[],
    prepare: NonNullable<NonNullable<import("../index.js").AgentPluginV1["prepareLaunch"]>>,
    resume: boolean,
  ): Promise<AgentBackendLaunch> {
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
        startedAt: timestamp(),
        backendSessionId: session.backendSessionId ?? null,
        environment: this.options.environment,
      },
      resumeSessionId: resume ? (session.backendSessionId ?? null) : null,
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
    session: AgentSessionRecord,
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
