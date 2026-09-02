import type {
  AgentExecutionResult,
  AgentObservationPort,
  AgentStateObservation,
  LaunchPreparation,
  RemoteSessionPort,
  SessionBaselineResult,
  SessionLauncherPort,
  SessionResourcePort,
} from "@muximo/application";
import type { AgentSessionRecord } from "@muximo/domain";
import type {
  AgentBackendLaunch,
  AgentBackendProviderOptions,
  AgentBackendProviderRegistry,
} from "../agents/backend.js";
import type { AgentMonitor, AgentObservation } from "../agents/index.js";
import { errorFields } from "../logging/index.js";
import { stringEnvironment } from "../process/process.js";

export type BackendAdapterOptions = AgentBackendProviderOptions & {
  observations: AgentObservationPort;
  providers: AgentBackendProviderRegistry;
};

type PreparedLaunchRuntime = {
  launch: AgentBackendLaunch;
  provider: ReturnType<AgentBackendProviderRegistry["get"]>;
  runDir: string;
  startedAt: number;
  monitor?: AgentMonitor;
  monitorStarted: boolean;
  monitorStarting?: Promise<void>;
};

/** Generic launch adapter; provider behavior is delegated to the agent registry. */
export class AgentBackendAdapter implements SessionLauncherPort, RemoteSessionPort, SessionResourcePort {
  private readonly prepared = new Map<string, PreparedLaunchRuntime>();

  public constructor(private readonly options: BackendAdapterOptions) {}

  public captureBaseline(session: AgentSessionRecord): Promise<SessionBaselineResult> {
    return this.options.providers.get(session.backend).captureBaseline(session);
  }

  public async prepareLaunch(
    session: AgentSessionRecord,
    backendArgs: readonly string[],
    resume: boolean,
    signal?: AbortSignal,
  ): Promise<LaunchPreparation> {
    const provider = this.options.providers.get(session.backend);
    const preparation = await provider.prepareLaunch(session, backendArgs, resume, signal);
    const runDir = session.worktreePath ?? session.workspaceRoot;
    const launch = preparation.launch;
    if (!launch.command[0]) throw new Error("backend command executable is missing");
    if (!session.executionId) throw new Error("agent execution id is missing");
    const runtime: PreparedLaunchRuntime = {
      launch,
      provider,
      runDir,
      startedAt: launchStartedAt(session),
      monitorStarted: false,
    };
    this.prepared.set(session.executionId, runtime);
    return {
      execution: {
        sessionId: session.id,
        executionId: session.executionId,
        sessionName: session.name,
        backend: session.backend,
        command: [...launch.command],
        cwd: runDir,
        environment: stringEnvironment({
          ...this.options.environment,
          MUXIMOD_AGENT_SESSION_ID: session.id,
          MUXIMOD_AGENT_ID: session.backend,
        }),
      },
      sessionUpdate: preparation.sessionUpdate,
    };
  }

  public async startLaunch(session: AgentSessionRecord): Promise<void> {
    if (!session.executionId) throw new Error("agent execution id is missing");
    let runtime = this.prepared.get(session.executionId);
    if (!runtime) {
      runtime = await this.restoreRuntime(session);
      if (!runtime) return;
      this.prepared.set(session.executionId, runtime);
    }
    if (runtime.monitorStarted) return;
    if (runtime.monitorStarting) return runtime.monitorStarting;
    const starting = this.startMonitor(session, runtime);
    runtime.monitorStarting = starting;
    try {
      await starting;
    } finally {
      if (runtime.monitorStarting === starting) runtime.monitorStarting = undefined;
    }
  }

  /** Rebuilds observers for live host-owned executions after daemon startup. */
  public async restoreActiveLaunches(): Promise<void> {
    for (const session of await this.options.sessions.list()) {
      if (
        (session.status !== "running" && session.status !== "resuming") ||
        session.executionId === undefined ||
        session.executionPid === undefined
      ) {
        continue;
      }
      try {
        await this.startLaunch(session);
      } catch (error) {
        this.options.logger.warn("agent.monitor_restore_failed", {
          sessionId: session.id,
          executionId: session.executionId,
          ...errorFields(error),
        });
      }
    }
  }

  public async completeLaunch(
    session: AgentSessionRecord,
    process: AgentExecutionResult,
  ): Promise<import("@muximo/application").SessionIdentityUpdate | undefined> {
    if (!session.executionId) throw new Error("agent execution id is missing");
    const runtime = this.prepared.get(session.executionId);
    const provider = runtime?.provider ?? this.options.providers.get(session.backend);
    const runDir = runtime?.runDir ?? session.worktreePath ?? session.workspaceRoot;
    const startedAt = runtime?.startedAt ?? launchStartedAt(session);
    try {
      if (runtime?.monitorStarting) await runtime.monitorStarting;
      if (process.interrupted && runtime?.launch.abortSession) {
        try {
          await runtime.launch.abortSession();
        } catch (error) {
          this.options.logger.warn("agent.session_abort_failed", { ...errorFields(error), sessionName: session.name });
        }
      }
      return await provider.afterRun(session, runDir, startedAt);
    } finally {
      if (runtime?.monitorStarted && runtime.monitor) {
        try {
          await runtime.monitor.stop();
        } catch (error) {
          this.options.logger.debug("agent.monitor_stop_failed", errorFields(error));
        }
      }
      if (runtime) {
        try {
          await runtime.launch.dispose?.();
        } finally {
          this.prepared.delete(session.executionId);
        }
      } else {
        await provider.disposeLaunch(session, runDir);
      }
    }
  }

  public async disposeLaunch(session: AgentSessionRecord): Promise<void> {
    if (!session.executionId) return;
    const runtime = this.prepared.get(session.executionId);
    if (runtime) {
      try {
        if (runtime.monitorStarting) await runtime.monitorStarting;
        if (runtime.monitorStarted && runtime.monitor) await runtime.monitor.stop();
        await runtime.launch.dispose?.();
      } finally {
        this.prepared.delete(session.executionId);
      }
      return;
    }
    await this.options.providers
      .get(session.backend)
      .disposeLaunch(session, session.worktreePath ?? session.workspaceRoot);
  }

  /**
   * Stops daemon-side observers while leaving the host-owned agent process untouched.
   * Launch disposal belongs to completion/recovery because it may release resources
   * that the host-owned provider process still needs.
   */
  public async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const [executionId, runtime] of this.prepared) {
      if (runtime.monitorStarting) {
        try {
          await runtime.monitorStarting;
        } catch (error) {
          errors.push(error);
        }
      }
      if (runtime.monitorStarted && runtime.monitor) {
        try {
          await runtime.monitor.stop();
        } catch (error) {
          errors.push(error);
        }
      }
      this.prepared.delete(executionId);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "agent monitor cleanup failed");
  }

  public archive(session: AgentSessionRecord): Promise<boolean> {
    return this.options.providers.get(session.backend).archive(session);
  }

  public restore(session: AgentSessionRecord): Promise<boolean> {
    return this.options.providers.get(session.backend).restore(session);
  }

  public releaseIfUnused(session: AgentSessionRecord, remaining: readonly AgentSessionRecord[]): Promise<void> {
    return this.options.providers.get(session.backend).releaseIfUnused(session, remaining);
  }

  private createMonitor(session: AgentSessionRecord, runDir: string, startedAt: number): AgentMonitor | undefined {
    const plugin = this.options.plugins.get(session.backend);
    return plugin?.createMonitor?.({
      sessionId: session.id,
      executionId: session.executionId ?? "",
      cwd: runDir,
      startedAt: new Date(startedAt * 1_000).toISOString(),
      backendSessionId: session.backendSessionId ?? null,
      environment: this.options.environment,
    });
  }

  private async startMonitor(session: AgentSessionRecord, runtime: PreparedLaunchRuntime): Promise<void> {
    runtime.startedAt = launchStartedAt(session);
    const monitor = runtime.launch.monitor ?? this.createMonitor(session, runtime.runDir, runtime.startedAt);
    if (!monitor) return;
    runtime.monitor = monitor;
    try {
      await monitor.start((observation) => this.publishObservation(session, observation));
      runtime.monitorStarted = true;
    } catch (error) {
      this.options.logger.debug("agent.monitor_start_failed", errorFields(error));
    }
  }

  private async restoreRuntime(session: AgentSessionRecord): Promise<PreparedLaunchRuntime | undefined> {
    const provider = this.options.providers.get(session.backend);
    const runDir = session.worktreePath ?? session.workspaceRoot;
    const startedAt = launchStartedAt(session);
    const restored = await provider.restoreLaunch?.(session);
    const monitor = restored?.monitor ?? this.createMonitor(session, runDir, startedAt);
    if (!restored && !monitor) return undefined;
    return {
      launch: restored ?? { command: [], monitor },
      provider,
      runDir,
      startedAt,
      ...(monitor === undefined ? {} : { monitor }),
      monitorStarted: false,
    };
  }

  private async publishObservation(session: AgentSessionRecord, observation: AgentObservation): Promise<void> {
    if (observation.type !== "state_changed") return;
    const stateObservation: AgentStateObservation = {
      state: observation.state,
      ...(observation.recentOutput === undefined ? {} : { recentOutput: observation.recentOutput }),
    };
    try {
      await this.options.observations.observe(session, stateObservation);
    } catch (error) {
      // Observation delivery is best effort. The foreground agent must remain
      // usable when muximod is restarting or temporarily unavailable.
      this.options.logger.debug("agent.observation_publish_failed", {
        sessionId: session.id,
        state: observation.state,
        ...errorFields(error),
      });
    }
  }
}

function launchStartedAt(session: AgentSessionRecord): number {
  const parsed = session.executionStartedAt === undefined ? Number.NaN : Date.parse(session.executionStartedAt) / 1_000;
  return Number.isFinite(parsed) ? parsed : Math.floor(Date.now() / 1_000);
}
