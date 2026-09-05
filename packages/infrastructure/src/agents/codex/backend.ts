import type { SessionBaselineResult, SessionIdentityUpdate } from "@muximo/application";
import { type ApplicationEffect, attemptSync } from "@muximo/application";
import type { AgentSession } from "@muximo/domain";
import { Effect } from "effect";
import { fromPromise, runEffectAsPromise } from "../../effect.js";
import { errorFields } from "../../logging/index.js";
import type { AgentBackendProvider, AgentBackendProviderOptions, AgentBackendProviderPreparation } from "../backend.js";
import {
  buildCodexResumeCommand,
  buildCodexRunCommand,
  codexRemoteEndpoint,
  ensureCodexRemoteControl,
  resolveCodexCommand,
} from "./launch.js";
import { defaultCodexSocket, manageCodexThread } from "./remote-control.js";
import {
  type CodexSessionDeps,
  collectCodexSessionBaseline,
  discoverCodexSessionId,
  recoverCodexSessionId,
  reportCodexDiscoveryFailure,
} from "./session-discovery.js";
import type { CodexSessionState, CodexSessionStateRepository } from "./state.js";

export class CodexBackendProvider implements AgentBackendProvider {
  public readonly backend = "codex" as const;
  private remoteOperation: Promise<void> = Promise.resolve();

  public constructor(
    private readonly options: AgentBackendProviderOptions,
    private readonly state: CodexSessionStateRepository,
    private readonly defaultRemote: string,
  ) {}

  public captureBaseline(session: AgentSession): ApplicationEffect<SessionBaselineResult> {
    const stateRepository = this.state;
    const dependencies = this.codexDeps();
    return Effect.gen(function* () {
      if (session.backend !== "codex") return { success: true };
      const collected = collectCodexSessionBaseline(dependencies);
      const current = (yield* stateRepository.find(session.id)) ?? {};
      yield* stateRepository.save(
        session.id,
        { ...current, sessionBaseline: collected.baseline },
        session.lastActivityAt,
      );
      return { success: true };
    });
  }

  public prepareLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    _signal?: AbortSignal,
  ): ApplicationEffect<AgentBackendProviderPreparation> {
    const stateRepository = this.state;
    const environment = this.options.environment;
    const logger = this.options.logger;
    const defaultRemote = this.defaultRemote;
    const dependencies = this.codexDeps();
    return Effect.gen(function* () {
      let effective = session;
      let sessionUpdate: SessionIdentityUpdate | undefined;
      const currentState = (yield* stateRepository.find(session.id)) ?? {};
      const runDir = session.worktreePath ?? session.workspaceRoot;

      if (resume && !session.backendSessionId) {
        const recovered = yield* recoverCodexSessionId(dependencies, session, runDir);
        if (!recovered.selectedId)
          return yield* Effect.fail(
            new Error(`session '${session.name}' has no backend session ID; it cannot be resumed`),
          );
        const update = { backendSessionId: recovered.selectedId } satisfies SessionIdentityUpdate;
        sessionUpdate = update;
        effective = yield* attemptSync(() => effective.update(update));
      }

      const profile = currentState.profile ?? profileFromArgs(backendArgs);
      const state: CodexSessionState = {
        ...currentState,
        ...(profile === undefined ? {} : { profile }),
        remote: currentState.remote ?? codexRemoteEndpoint(backendArgs, defaultRemote),
      };
      yield* stateRepository.save(session.id, state, session.lastActivityAt);

      const binary = yield* attemptSync(() => resolveCodexCommand(environment));
      yield* attemptSync(() => ensureCodexRemoteControl(backendArgs, binary, defaultRemote, environment, logger));
      const command = resume
        ? buildCodexResumeCommand(effective, backendArgs, defaultRemote, binary, state)
        : buildCodexRunCommand(effective, backendArgs, defaultRemote, binary, state);
      return { sessionUpdate, launch: { command } };
    });
  }

  public afterRun(
    session: AgentSession,
    runDir: string,
    startedAt: number,
  ): ApplicationEffect<SessionIdentityUpdate | undefined> {
    const dependencies = this.codexDeps();
    const manageRemoteOperation = this.manageRemoteOperation.bind(this);
    return Effect.gen(function* () {
      if (session.backendSessionId) return undefined;
      const discovery = yield* discoverCodexSessionId(dependencies, startedAt, runDir, session.id);
      if (!discovery.selectedId) {
        yield* reportCodexDiscoveryFailure(dependencies, session, runDir, "finalize", discovery);
        return undefined;
      }
      const selectedId = discovery.selectedId;
      const sessionUpdate = { backendSessionId: selectedId } satisfies SessionIdentityUpdate;
      const updated = yield* attemptSync(() => session.update({ backendSessionId: selectedId }));
      yield* fromPromise(() => manageRemoteOperation(updated, "name"));
      return sessionUpdate;
    });
  }

  public disposeLaunch(_session: AgentSession, _runDir: string): ApplicationEffect<void> {
    return Effect.succeed(undefined);
  }

  public archive(session: AgentSession): ApplicationEffect<boolean> {
    return fromPromise(() => this.manageRemoteOperation(session, "archive"));
  }

  public restore(session: AgentSession): ApplicationEffect<boolean> {
    return fromPromise(() => this.manageRemoteOperation(session, "unarchive"));
  }

  public releaseIfUnused(session: AgentSession, _remaining: readonly AgentSession[]): ApplicationEffect<void> {
    return this.state.delete(session.id);
  }

  private async manageRemoteOperation(
    session: AgentSession,
    operation: "name" | "archive" | "unarchive",
  ): Promise<boolean> {
    // Keep the Promise mutex: remote thread mutations must remain strictly ordered,
    // while the state lookup is the single intentional bridge into the Effect port.
    const state = await runEffectAsPromise(this.state.find(session.id));
    if (!state?.remote || !session.backendSessionId) {
      this.options.logger.warn("codex.remote_operation_unavailable", {
        operation,
        sessionId: session.id,
        reason: "incomplete_metadata",
      });
      return false;
    }
    if (state.remote !== "unix://") {
      this.options.logger.warn("codex.remote_operation_unavailable", {
        operation,
        sessionId: session.id,
        reason: "unsupported_remote",
      });
      return false;
    }
    const threadId = session.backendSessionId;
    if (!threadId) {
      this.options.logger.warn("codex.remote_operation_unavailable", {
        operation,
        sessionId: session.id,
        reason: "missing_backend_session_id",
      });
      return false;
    }

    let result = false;
    const queued = this.remoteOperation.then(async () => {
      try {
        await manageCodexThread({
          threadId,
          operation,
          name: operation === "name" ? session.name : undefined,
          socketPath: defaultCodexSocket(this.options.environment),
        });
        result = true;
      } catch (error) {
        this.options.logger.warn("codex.remote_operation_failed", {
          operation,
          sessionId: session.id,
          backendSessionId: session.backendSessionId,
          ...errorFields(error),
        });
      }
    });
    this.remoteOperation = queued.catch(() => undefined);
    await queued;
    return result;
  }

  private codexDeps(): CodexSessionDeps {
    return {
      env: this.options.environment,
      logger: this.options.logger,
      sessions: this.options.sessions,
      state: this.state,
      audit: (eventType, entityId, payload) => this.options.audit.record(eventType, entityId, payload),
      manageRemoteThread: (session, operation, signal) =>
        signal?.aborted ? Promise.resolve(false) : this.manageRemoteOperation(session, operation),
    };
  }
}

function profileFromArgs(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument?.startsWith("--profile=")) return argument.slice("--profile=".length) || undefined;
    if ((argument === "--profile" || argument === "-p") && args[index + 1]) return args[index + 1];
  }
  return undefined;
}
