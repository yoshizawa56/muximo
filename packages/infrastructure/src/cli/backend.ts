import type {
  AgentExecutionPort,
  AgentObservationPort,
  AgentStateObservation,
  LaunchExecution,
  LaunchPlan,
  LaunchPreparation,
  ProcessResult,
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
import type { TerminalTitlePort } from "../terminal/title.js";

export type BackendAdapterOptions = AgentBackendProviderOptions & {
  observations: AgentObservationPort;
  providers: AgentBackendProviderRegistry;
  terminalTitle?: TerminalTitlePort;
};

/** Generic launch adapter; provider behavior is delegated to the agent registry. */
export class AgentBackendAdapter implements SessionLauncherPort, RemoteSessionPort, SessionResourcePort {
  public constructor(private readonly options: BackendAdapterOptions) {}

  public captureBaseline(session: AgentSessionRecord): Promise<SessionBaselineResult> {
    return this.options.providers.get(session.backend).captureBaseline(session);
  }

  public async prepareLaunch(
    session: AgentSessionRecord,
    backendArgs: readonly string[],
    resume: boolean,
  ): Promise<LaunchPreparation> {
    const provider = this.options.providers.get(session.backend);
    const preparation = await provider.prepareLaunch(session, backendArgs, resume);
    const runDir = session.worktreePath ?? session.workspaceRoot;
    return {
      sessionUpdate: preparation.sessionUpdate,
      plan: this.wrapPlan(preparation.launch, session, runDir, provider),
    };
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

  private wrapPlan(
    launch: AgentBackendLaunch,
    session: AgentSessionRecord,
    runDir: string,
    provider: ReturnType<AgentBackendProviderRegistry["get"]>,
  ): LaunchPlan {
    const startedAt = Math.floor(Date.now() / 1_000);
    let runPromise: Promise<LaunchExecution> | undefined;
    let disposal: Promise<void> | undefined;
    return {
      run: (execution: AgentExecutionPort) => {
        if (!runPromise) {
          runPromise = this.runBackend(session, launch, runDir, startedAt, execution).then(async (process) => ({
            process,
            sessionUpdate: await provider.afterRun(session, runDir, startedAt),
          }));
        }
        return runPromise;
      },
      dispose: () => {
        if (!disposal) disposal = Promise.resolve().then(() => launch.dispose?.());
        return disposal;
      },
    };
  }

  private async runBackend(
    session: AgentSessionRecord,
    launch: AgentBackendLaunch,
    runDir: string,
    startedAt: number,
    execution: AgentExecutionPort,
  ): Promise<ProcessResult> {
    const logger = this.options.logger.child({
      sessionId: session.id,
      sessionName: session.name,
      backend: session.backend,
    });
    const processStartedAt = Date.now();
    const monitor = launch.monitor ?? this.createMonitor(session, runDir, startedAt);
    let monitorStarted = false;
    this.options.terminalTitle?.set(`muximo:${session.name}`);
    try {
      if (monitor) {
        try {
          await monitor.start((observation) => this.publishObservation(session, observation));
          monitorStarted = true;
        } catch (error) {
          logger.debug("agent.monitor_start_failed", errorFields(error));
        }
      }
      if (!launch.command[0]) throw new Error("backend command executable is missing");
      if (!session.executionId) throw new Error("agent execution id is missing");
      const result = await execution.execute({
        sessionId: session.id,
        executionId: session.executionId,
        sessionName: session.name,
        backend: session.backend,
        command: launch.command,
        cwd: runDir,
        environment: stringEnvironment({
          ...this.options.environment,
          MUXIMOD_AGENT_SESSION_ID: session.id,
          MUXIMOD_AGENT_ID: session.backend,
        }),
      });
      if (result.interrupted && launch.abortSession) {
        try {
          await launch.abortSession();
        } catch (error) {
          logger.warn("agent.session_abort_failed", { ...errorFields(error), sessionName: session.name });
        }
      }
      const finishedFields = {
        kind: "backend",
        pid: result.pid,
        started: result.started,
        exitCode: result.code,
        signal: result.signal,
        interrupted: result.interrupted,
        durationMs: Date.now() - processStartedAt,
        ...(result.failureDiagnostic === undefined ? {} : { failureDiagnostic: result.failureDiagnostic }),
      };
      if (result.code === 0) logger.debug("subprocess.finished", finishedFields);
      else logger.warn("subprocess.failed", finishedFields);
      return {
        started: result.started,
        code: result.code,
        interrupted: result.interrupted,
        signal: result.signal,
        ...(result.failureDiagnostic === undefined ? {} : { failureDiagnostic: result.failureDiagnostic }),
      };
    } finally {
      if (monitorStarted && monitor) {
        try {
          await monitor.stop();
        } catch (error) {
          logger.debug("agent.monitor_stop_failed", errorFields(error));
        }
      }
      this.options.terminalTitle?.restore();
    }
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
