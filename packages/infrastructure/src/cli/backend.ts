import type {
  AgentExecutionResult,
  AgentObservation as AgentObservationCapability,
  AgentStateObservation,
  ApplicationEffect,
  LaunchPreparation,
  RemoteSession,
  SessionBaselineResult,
  SessionLauncher,
  SessionResource,
} from "@muximo/application";
import { attemptSync } from "@muximo/application";
import type { AgentSession } from "@muximo/domain";
import { Effect } from "effect";
import type {
  AgentBackendLaunch,
  AgentBackendProviderOptions,
  AgentBackendProviderRegistry,
} from "../agents/backend.js";
import type { AgentMonitor, AgentObservation } from "../agents/index.js";
import { fromPromise, runEffectAsPromise } from "../effect.js";
import { errorFields } from "../logging/index.js";
import { stringEnvironment } from "../process/process.js";

export type BackendAdapterOptions = AgentBackendProviderOptions & {
  observations: AgentObservationCapability;
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
export class AgentBackendAdapter implements SessionLauncher, RemoteSession, SessionResource {
  private readonly prepared = new Map<string, PreparedLaunchRuntime>();

  public constructor(private readonly options: BackendAdapterOptions) {}

  public captureBaseline(session: AgentSession): ApplicationEffect<SessionBaselineResult> {
    const options = this.options;
    return Effect.gen(function* () {
      const provider = yield* attemptSync(() => options.providers.get(session.backend));
      return yield* provider.captureBaseline(session);
    });
  }

  public prepareLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    signal?: AbortSignal,
  ): ApplicationEffect<LaunchPreparation> {
    // The adapter keeps this one Promise thunk solely to pass Effect's abort
    // signal into the provider boundary; the provider operation itself stays
    // an Effect and is composed directly in prepareLaunchEffect.
    return fromPromise((effectSignal) =>
      runEffectAsPromise(this.prepareLaunchEffect(session, backendArgs, resume, signal ?? effectSignal)),
    );
  }

  private prepareLaunchEffect(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    signal?: AbortSignal,
  ): ApplicationEffect<LaunchPreparation> {
    const options = this.options;
    const prepared = this.prepared;
    return Effect.gen(function* () {
      const provider = yield* attemptSync(() => options.providers.get(session.backend));
      const preparation = yield* provider.prepareLaunch(session, backendArgs, resume, signal);
      const runDir = session.worktreePath ?? session.workspaceRoot;
      const launch = preparation.launch;
      if (!launch.command[0]) return yield* Effect.fail(new Error("backend command executable is missing"));
      const executionId = session.executionId;
      if (!executionId) return yield* Effect.fail(new Error("agent execution id is missing"));
      const runtime: PreparedLaunchRuntime = {
        launch,
        provider,
        runDir,
        startedAt: launchStartedAt(session),
        monitorStarted: false,
      };
      prepared.set(executionId, runtime);
      return {
        execution: {
          sessionId: session.id,
          executionId,
          sessionName: session.name,
          backend: session.backend,
          command: [...launch.command],
          cwd: runDir,
          environment: stringEnvironment({
            ...options.environment,
            MUXIMOD_AGENT_SESSION_ID: session.id,
            MUXIMOD_AGENT_ID: session.backend,
          }),
        },
        sessionUpdate: preparation.sessionUpdate,
      };
    });
  }

  public startLaunch(session: AgentSession): ApplicationEffect<void> {
    const prepared = this.prepared;
    const restoreRuntime = this.restoreRuntime.bind(this);
    const startMonitor = this.startMonitor.bind(this);
    return Effect.gen(function* () {
      if (!session.executionId) return yield* Effect.fail(new Error("agent execution id is missing"));
      let runtime = prepared.get(session.executionId);
      if (!runtime) {
        runtime = yield* restoreRuntime(session);
        if (!runtime) return;
        prepared.set(session.executionId, runtime);
      }
      if (runtime.monitorStarted) return;
      if (runtime.monitorStarting) {
        yield* fromPromise(() => runtime.monitorStarting as Promise<void>);
        return;
      }
      const starting = startMonitor(session, runtime);
      runtime.monitorStarting = starting;
      try {
        yield* fromPromise(() => starting);
      } finally {
        if (runtime.monitorStarting === starting) runtime.monitorStarting = undefined;
      }
    });
  }

  /** Rebuilds observers for live host-owned executions after daemon startup. */
  public restoreActiveLaunches(): ApplicationEffect<void> {
    const self = this;
    return Effect.gen(function* () {
      for (const session of yield* self.options.sessions.list()) {
        if (
          (session.status !== "running" && session.status !== "resuming") ||
          session.executionId === undefined ||
          session.executionPid === undefined
        ) {
          continue;
        }
        const started = yield* Effect.result(self.startLaunch(session));
        if (started._tag === "Failure") {
          self.options.logger.warn("agent.monitor_restore_failed", {
            sessionId: session.id,
            executionId: session.executionId,
            ...errorFields(started.failure),
          });
        }
      }
    });
  }

  public completeLaunch(
    session: AgentSession,
    process: AgentExecutionResult,
  ): ApplicationEffect<import("@muximo/application").SessionIdentityUpdate | undefined> {
    const prepared = this.prepared;
    const options = this.options;
    return Effect.gen(function* () {
      const executionId = session.executionId;
      if (!executionId) return yield* Effect.fail(new Error("agent execution id is missing"));
      const runtime = prepared.get(executionId);
      const provider = runtime?.provider ?? (yield* attemptSync(() => options.providers.get(session.backend)));
      const runDir = runtime?.runDir ?? session.worktreePath ?? session.workspaceRoot;
      const startedAt = runtime?.startedAt ?? launchStartedAt(session);
      const main = Effect.gen(function* () {
        const monitorStarting = runtime?.monitorStarting;
        if (monitorStarting) yield* fromPromise(() => monitorStarting);
        const abortSession = runtime?.launch.abortSession;
        if (process.interrupted && abortSession) {
          yield* fromPromise(() => abortSession()).pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                options.logger.warn("agent.session_abort_failed", {
                  ...errorFields(error),
                  sessionName: session.name,
                }),
              ),
            ),
          );
        }
        return yield* provider.afterRun(session, runDir, startedAt);
      });
      const cleanup = runtime
        ? Effect.gen(function* () {
            const monitor = runtime.monitor;
            if (runtime.monitorStarted && monitor) {
              yield* fromPromise(() => monitor.stop()).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => options.logger.debug("agent.monitor_stop_failed", errorFields(error))),
                ),
              );
            }
            const dispose = runtime.launch.dispose;
            if (dispose) yield* fromPromise(() => dispose());
          }).pipe(Effect.ensuring(Effect.sync(() => prepared.delete(executionId))))
        : provider.disposeLaunch(session, runDir);
      const mainResult = yield* Effect.result(main);
      const cleanupResult = yield* Effect.result(cleanup);
      if (mainResult._tag === "Failure") return yield* Effect.fail(mainResult.failure);
      if (cleanupResult._tag === "Failure") return yield* Effect.fail(cleanupResult.failure);
      return mainResult.success;
    });
  }

  public disposeLaunch(session: AgentSession): ApplicationEffect<void> {
    const prepared = this.prepared;
    const options = this.options;
    return Effect.gen(function* () {
      const executionId = session.executionId;
      if (!executionId) return;
      const runtime = prepared.get(executionId);
      if (runtime) {
        const dispose = runtime.launch.dispose;
        const monitorStarting = runtime.monitorStarting;
        const monitor = runtime.monitor;
        const cleanup = Effect.gen(function* () {
          if (monitorStarting) yield* fromPromise(() => monitorStarting);
          if (runtime.monitorStarted && monitor) yield* fromPromise(() => monitor.stop());
          if (dispose) yield* fromPromise(() => dispose());
        });
        yield* Effect.ensuring(
          cleanup,
          Effect.sync(() => prepared.delete(executionId)),
        );
        return;
      }
      const provider = yield* attemptSync(() => options.providers.get(session.backend));
      yield* provider.disposeLaunch(session, session.worktreePath ?? session.workspaceRoot);
    });
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

  public archive(session: AgentSession): ApplicationEffect<boolean> {
    const options = this.options;
    return Effect.gen(function* () {
      const provider = yield* attemptSync(() => options.providers.get(session.backend));
      return yield* provider.archive(session);
    });
  }

  public restore(session: AgentSession): ApplicationEffect<boolean> {
    const options = this.options;
    return Effect.gen(function* () {
      const provider = yield* attemptSync(() => options.providers.get(session.backend));
      return yield* provider.restore(session);
    });
  }

  public releaseIfUnused(session: AgentSession, remaining: readonly AgentSession[]): ApplicationEffect<void> {
    const options = this.options;
    return Effect.gen(function* () {
      const provider = yield* attemptSync(() => options.providers.get(session.backend));
      yield* provider.releaseIfUnused(session, remaining);
    });
  }

  private createMonitor(session: AgentSession, runDir: string, startedAt: number): AgentMonitor | undefined {
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

  private async startMonitor(session: AgentSession, runtime: PreparedLaunchRuntime): Promise<void> {
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

  private restoreRuntime(session: AgentSession): ApplicationEffect<PreparedLaunchRuntime | undefined> {
    const options = this.options;
    const createMonitor = this.createMonitor.bind(this);
    return Effect.gen(function* () {
      const provider = yield* attemptSync(() => options.providers.get(session.backend));
      const runDir = session.worktreePath ?? session.workspaceRoot;
      const startedAt = launchStartedAt(session);
      const restored = provider.restoreLaunch ? yield* provider.restoreLaunch(session) : undefined;
      const monitor = restored?.monitor ?? createMonitor(session, runDir, startedAt);
      if (!restored && !monitor) return undefined;
      return {
        launch: restored ?? { command: [], monitor },
        provider,
        runDir,
        startedAt,
        ...(monitor === undefined ? {} : { monitor }),
        monitorStarted: false,
      };
    });
  }

  private async publishObservation(session: AgentSession, observation: AgentObservation): Promise<void> {
    if (observation.type !== "state_changed") return;
    const stateObservation: AgentStateObservation = {
      state: observation.state,
      ...(observation.recentOutput === undefined ? {} : { recentOutput: observation.recentOutput }),
    };
    try {
      await runEffectAsPromise(this.options.observations.observe(session, stateObservation));
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

function launchStartedAt(session: AgentSession): number {
  const parsed = session.executionStartedAt === undefined ? Number.NaN : Date.parse(session.executionStartedAt) / 1_000;
  return Number.isFinite(parsed) ? parsed : Math.floor(Date.now() / 1_000);
}
