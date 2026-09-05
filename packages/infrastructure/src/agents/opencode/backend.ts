import {
  type ApplicationEffect,
  attemptSync,
  type SessionBaselineResult,
  type SessionIdentityUpdate,
} from "@muximo/application";
import type { AgentSession } from "@muximo/domain";
import { Effect } from "effect";
import { timestamp } from "../../cli/filesystem.js";
import { fromPromise } from "../../effect.js";
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

  public captureBaseline(_session: AgentSession): ApplicationEffect<SessionBaselineResult> {
    return Effect.succeed({ success: true });
  }

  public prepareLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    signal?: AbortSignal,
  ): ApplicationEffect<AgentBackendProviderPreparation> {
    const plugins = this.options.plugins;
    const backend = this.backend;
    const preparePluginLaunch = this.preparePluginLaunch.bind(this);
    const prepareCommandLaunch = this.prepareCommandLaunch.bind(this);
    const environment = this.options.environment;
    return Effect.gen(function* () {
      const plugin = plugins.get(backend);
      const launch = plugin?.prepareLaunch
        ? yield* preparePluginLaunch(session, backendArgs, plugin.prepareLaunch, resume, signal)
        : yield* attemptSync(() => prepareCommandLaunch(session, backendArgs, resume, environment));
      let sessionUpdate: SessionIdentityUpdate | undefined;
      if (launch.backendSessionId && !session.backendSessionId) {
        sessionUpdate = { backendSessionId: launch.backendSessionId };
      }
      return { sessionUpdate, launch };
    });
  }

  public restoreLaunch(session: AgentSession): ApplicationEffect<AgentBackendLaunch | undefined> {
    const plugins = this.options.plugins;
    const preparePluginLaunch = this.preparePluginLaunch.bind(this);
    return Effect.gen(function* () {
      const plugin = plugins.get("opencode");
      if (!plugin?.prepareLaunch || !session.backendSessionId) return undefined;
      return yield* preparePluginLaunch(session, [], plugin.prepareLaunch, true, undefined, session.executionStartedAt);
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
    // OpenCode servers are shared service references. Releasing a session must
    // never terminate a server that may be used by another daemon or client.
    return Effect.succeed(undefined);
  }

  public archive(_session: AgentSession): ApplicationEffect<boolean> {
    return Effect.succeed(true);
  }

  public restore(_session: AgentSession): ApplicationEffect<boolean> {
    return Effect.succeed(true);
  }

  public releaseIfUnused(_session: AgentSession, _remaining: readonly AgentSession[]): ApplicationEffect<void> {
    // OpenCode server lifetime is independent from agent-session cleanup.
    return Effect.succeed(undefined);
  }

  private preparePluginLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    prepare: NonNullable<NonNullable<import("../index.js").AgentPluginV1["prepareLaunch"]>>,
    resume: boolean,
    signal?: AbortSignal,
    startedAt = timestamp(),
  ): ApplicationEffect<AgentBackendLaunch> {
    const runDir = session.worktreePath ?? session.workspaceRoot;
    const environment = this.options.environment;
    return Effect.gen(function* () {
      signal?.throwIfAborted();
      const plan = yield* fromPromise(() =>
        prepare({
          cwd: runDir,
          args: [...backendArgs],
          environment: stringEnvironment(environment),
          name: session.name,
          monitorContext: {
            sessionId: session.id,
            executionId: session.executionId ?? "",
            cwd: runDir,
            startedAt,
            backendSessionId: session.backendSessionId ?? null,
            environment,
          },
          resumeSessionId: resume ? (session.backendSessionId ?? null) : null,
          signal,
        }),
      );
      return {
        command: [plan.primary.command, ...plan.primary.args],
        monitor: plan.monitor,
        backendSessionId: plan.backendSessionId ?? null,
        abortSession: plan.monitor?.execute
          ? async () => plan.monitor?.execute?.({ ...openCodeMonitorActions.abort })
          : undefined,
        dispose: plan.dispose ?? (async () => undefined),
      };
    });
  }

  private prepareCommandLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    environment: NodeJS.ProcessEnv,
  ): AgentBackendLaunch {
    const binary = resolveOpenCodeCommand(environment);
    return {
      command: resume
        ? buildOpenCodeResumeCommand(session, backendArgs, binary)
        : buildOpenCodeRunCommand(session, backendArgs, binary),
    };
  }
}
