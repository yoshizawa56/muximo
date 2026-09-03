import type { SessionBaselineResult, SessionIdentityUpdate } from "@muximo/application";
import type { AgentSession } from "@muximo/domain";
import { runEffectAsPromise } from "../../effect.js";
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

  public async captureBaseline(session: AgentSession): Promise<SessionBaselineResult> {
    if (session.backend !== this.backend) return { success: true };
    const collected = await collectCodexSessionBaseline(this.codexDeps());
    const current = (await this.state.find(session.id)) ?? {};
    await this.state.save(session.id, { ...current, sessionBaseline: collected.baseline }, session.lastActivityAt);
    return { success: true };
  }

  public async prepareLaunch(
    session: AgentSession,
    backendArgs: readonly string[],
    resume: boolean,
    _signal?: AbortSignal,
  ): Promise<AgentBackendProviderPreparation> {
    let effective = session;
    let sessionUpdate: SessionIdentityUpdate | undefined;
    const currentState = (await this.state.find(session.id)) ?? {};
    const runDir = session.worktreePath ?? session.workspaceRoot;

    if (resume && !session.backendSessionId) {
      const recovered = await recoverCodexSessionId(this.codexDeps(), session, runDir);
      if (!recovered.selectedId) {
        throw new Error(`session '${session.name}' has no backend session ID; it cannot be resumed`);
      }
      sessionUpdate = { backendSessionId: recovered.selectedId };
      effective = effective.update(sessionUpdate);
    }

    const profile = currentState.profile ?? profileFromArgs(backendArgs);
    const state: CodexSessionState = {
      ...currentState,
      ...(profile === undefined ? {} : { profile }),
      remote: currentState.remote ?? codexRemoteEndpoint(backendArgs, this.defaultRemote),
    };
    await this.state.save(session.id, state, session.lastActivityAt);

    const binary = resolveCodexCommand(this.options.environment);
    ensureCodexRemoteControl(backendArgs, binary, this.defaultRemote, this.options.environment, this.options.logger);
    const command = resume
      ? buildCodexResumeCommand(effective, backendArgs, this.defaultRemote, binary, state)
      : buildCodexRunCommand(effective, backendArgs, this.defaultRemote, binary, state);
    return { sessionUpdate, launch: { command } };
  }

  public async afterRun(
    session: AgentSession,
    runDir: string,
    startedAt: number,
  ): Promise<SessionIdentityUpdate | undefined> {
    if (session.backendSessionId) return undefined;
    const discovery = await discoverCodexSessionId(this.codexDeps(), startedAt, runDir, session.id);
    if (!discovery.selectedId) {
      await reportCodexDiscoveryFailure(this.codexDeps(), session, runDir, "finalize", discovery);
      return undefined;
    }
    const sessionUpdate = { backendSessionId: discovery.selectedId } satisfies SessionIdentityUpdate;
    await this.manageRemoteOperation(session.update({ backendSessionId: discovery.selectedId }), "name");
    return sessionUpdate;
  }

  public async disposeLaunch(_session: AgentSession, _runDir: string): Promise<void> {}

  public archive(session: AgentSession): Promise<boolean> {
    return this.manageRemoteOperation(session, "archive");
  }

  public restore(session: AgentSession): Promise<boolean> {
    return this.manageRemoteOperation(session, "unarchive");
  }

  public async releaseIfUnused(session: AgentSession, _remaining: readonly AgentSession[]): Promise<void> {
    await this.state.delete(session.id);
  }

  private async manageRemoteOperation(
    session: AgentSession,
    operation: "name" | "archive" | "unarchive",
  ): Promise<boolean> {
    const state = await this.state.find(session.id);
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
      audit: (eventType, entityId, payload) =>
        runEffectAsPromise(this.options.audit.record(eventType, entityId, payload)),
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
