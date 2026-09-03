import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  type DaemonOptions,
  PairDevice,
  type ResumeAgentSessionInput,
  RunShell,
  type StartAgentSessionInput,
} from "@muximo/application";
import type { ResumeAgentSessionResponse, RunAgentSessionResponse } from "@muximo/contract/api";
import { AgentSession } from "@muximo/domain";
import {
  AttachedAgentExecutionAdapter,
  createLogger,
  createTailscaleServeClient,
  ensureTailscaleServe,
  GitShellWorktreeAdapter,
  GitWorktreeAdapter,
  hasTailscaleServeRoute,
  type Logger,
  type LogLevel,
  localMuximodUrl,
  readServeRouteState,
  removeServeRouteState,
  runDoctor,
  ShellProcessAdapter,
  TmuxAdapter,
  TmuxNewSessionService,
  TmuxPanePublicationAdapter,
  WorkspaceHookAdapter,
  writeServeRouteState,
} from "@muximo/infrastructure/cli-client";
import {
  createMuximodLifecycle,
  type MuximodForegroundConflictPolicy,
  type MuximodLifecycle,
  resolveMuximodClientPaths,
  validateMuximodControlSocketPath,
} from "@muximo/muximod/client";
import { Effect } from "effect";
import { confirmCleanup } from "./adapters/cleanup-prompt.js";
import { BrowserPairingPresenter, PairCommand, TerminalPairingPresenter } from "./adapters/index.js";
import { connectMuximodApi, type MuximodApiClient, readMuximodDaemonLog } from "./adapters/muximod-api-client.js";
import {
  MuximodPairingControlAdapter,
  muximodControlRequestTimeoutMs,
  PairingControlError,
} from "./adapters/muximod-pairing-control-adapter.js";
import { MuximodShellSessionWorktreeLookup, MuximodShellWorkspaceResolver } from "./adapters/muximod-shell-context.js";
import { resolvePairMuximodBaseUrl } from "./adapters/pair-route.js";
import { type CliApp, createCliApp } from "./app.js";
import type { CliHandlers, CliIo, CliRunInput } from "./commands/types.js";
import { createInteractiveHandlers } from "./handlers/interactive.js";
import { createPairHandler } from "./handlers/pair.js";
import { createSessionHandlers } from "./handlers/session.js";
import { createSystemHandlers, type ServeResult } from "./handlers/system.js";
import { createWorkspaceHandlers } from "./handlers/workspace.js";
import { createMuximodConfigResolver } from "./muximod-config.js";
import type { MuximoCliRuntimeOptions } from "./runtime-types.js";

export type CliCompositionOptions = {
  cwd?: string;
  environment: NodeJS.ProcessEnv;
  runtime: MuximoCliRuntimeOptions;
  io?: CliIo;
  input?: Readable;
  logger?: Logger;
  logLevel?: LogLevel;
  tmux?: TmuxAdapter;
  muximod?: MuximodLifecycle;
  muximodForegroundConflictPolicy?: MuximodForegroundConflictPolicy;
};

export type CliComposition = {
  app: CliApp;
  execute(args: readonly string[]): Promise<number>;
  close(): void;
};

/** The sole CLI composition root: all client and host resources are wired here. */
export function createCliComposition(options: CliCompositionOptions): CliComposition {
  const io = options.io ?? { out: process.stdout, err: process.stderr };
  const environment = options.environment;
  const runtime = options.runtime;
  const cwd = options.cwd ?? process.cwd();
  const hostPaneId = currentTmuxPane(environment);
  const logger =
    options.logger ??
    createLogger({
      service: "muximo-cli",
      mode: "attached",
      level: options.logLevel ?? (runtime.verbose ? "debug" : runtime.logLevel),
      output: io.err,
      showStack: options.logLevel === "debug" || (options.logLevel === undefined && runtime.verbose),
    });
  const paths = resolveMuximodClientPaths(
    { ...environment, MUXIMOD_INSTANCE_DIR: runtime.muximodInstanceDirectory },
    { baseDirectory: cwd },
  );
  const muximod =
    options.muximod ??
    createMuximodLifecycle({
      schemaMode: runtime.schemaMode,
      foregroundConflictPolicy: options.muximodForegroundConflictPolicy,
      environment,
      resolveConfig: createMuximodConfigResolver({
        environment,
        workingDirectory: cwd,
        runtime,
      }),
    });
  const localDaemon = () => {
    const host = runtime.muximodHost;
    const port = runtime.muximodPort;
    return {
      host,
      port,
      baseUrl: localMuximodUrl(host, port),
      pidFile: paths.pidFile,
      controlSocket: paths.controlSocket,
    };
  };
  type LocalDaemon = ReturnType<typeof localDaemon>;
  let ensurePromise: Promise<LocalDaemon> | undefined;
  const ensureLocalDaemon = async (): Promise<LocalDaemon> => {
    let currentPromise = ensurePromise;
    if (!currentPromise) {
      currentPromise = (async () => {
        const daemon = localDaemon();
        const result = await muximod.ensure({
          host: daemon.host,
          port: daemon.port,
          pidFile: daemon.pidFile,
          controlSocket: daemon.controlSocket,
        });
        return {
          ...daemon,
          host: result.host,
          port: result.port,
          baseUrl: localMuximodUrl(result.host, result.port),
        };
      })();
      ensurePromise = currentPromise;
    }
    try {
      return await currentPromise;
    } finally {
      if (ensurePromise === currentPromise) ensurePromise = undefined;
    }
  };
  let apiPromise: Promise<MuximodApiClient> | undefined;
  const invalidateApi = () => {
    apiPromise = undefined;
  };
  const ensureApi = (): Promise<MuximodApiClient> => {
    if (!apiPromise) {
      apiPromise = (async () => {
        const daemon = await ensureLocalDaemon();
        return connectMuximodApi({
          httpBaseUrl: daemon.baseUrl,
          controlSocket: daemon.controlSocket,
          cwd,
          ensureDaemon: async () => {
            await ensureLocalDaemon();
          },
          resolveHttpBaseUrl: async () => (await ensureLocalDaemon()).baseUrl,
        });
      })().catch((error) => {
        apiPromise = undefined;
        throw error;
      });
    }
    return apiPromise;
  };
  const worktrees = new GitWorktreeAdapter({
    environment,
    logger,
  });
  const shellHookOutputRoot = join(tmpdir(), `muximo-cli-hooks-${process.pid}-${randomUUID()}`);
  const hooks = new WorkspaceHookAdapter({
    environment,
    cwd,
    // Shell hooks are a host-only CLI workflow. Keep their transient output
    // outside the daemon instance so the client never writes daemon state.
    hookOutputRoot: shellHookOutputRoot,
    logger,
  });
  const tmux = options.tmux ?? new TmuxAdapter(environment.MUXIMOD_TMUX_SOCKET, undefined, environment);
  const pane = new TmuxPanePublicationAdapter({
    environment,
    controlSocket: paths.controlSocket,
    tmux,
    connect: (socketPath) => MuximodPairingControlAdapter.connect(socketPath),
    logger,
  });
  const shell = new RunShell({
    cwd,
    paneName: environment.MUXIMOD_PANE_NAME ?? environment.MUXIMOD_MANAGED_SESSION_NAME ?? "shell",
    defaultShell: environment.SHELL ?? "sh",
    workspace: new MuximodShellWorkspaceResolver({ cwd, environment, api: ensureApi }),
    sessions: new MuximodShellSessionWorktreeLookup(ensureApi),
    process: new ShellProcessAdapter({ environment }),
    worktrees: new GitShellWorktreeAdapter(worktrees),
    hooks,
    panes: pane,
  });
  const shellExecutor = {
    execute: (input: Parameters<RunShell["execute"]>[0]) => Effect.runPromise(shell.execute(input)),
  };
  const tmuxSession = new TmuxNewSessionService({ environment, tmux });
  const daemonDefaults: DaemonOptions = {
    host: runtime.muximodHost,
    port: runtime.muximodPort,
    pidFile: paths.pidFile,
    controlSocket: paths.controlSocket,
    logLevel: runtime.logLevel,
    logFile: runtime.logFile,
  };
  const serveStatePath = join(runtime.muximodInstanceDirectory, "serve.json");
  const attachedAgentExecution = new AttachedAgentExecutionAdapter(logger);
  const agentExecutionPrepareTimeoutMs = muximodControlRequestTimeoutMs * 2;
  const agentExecutionAttachTimeoutMs = 5_000;
  type AgentExecutionPreparation =
    | { operation: "run"; input: StartAgentSessionInput }
    | { operation: "resume"; input: ResumeAgentSessionInput };
  const prepareAgentExecution = async (request: AgentExecutionPreparation) => {
    if (!hasInteractiveTerminal()) {
      throw new Error("agent execution requires an interactive terminal (stdin, stdout, and stderr must be TTYs)");
    }
    const daemon = await ensureLocalDaemon();
    const control = await MuximodPairingControlAdapter.connect(daemon.controlSocket, {
      requestTimeoutMs: agentExecutionPrepareTimeoutMs,
    });
    try {
      if (request.operation === "run") {
        return await control.prepareAgentExecution({
          operation: "run",
          input: { ...request.input, executionOwnerPid: process.pid, backendArgs: [...request.input.backendArgs] },
        });
      }
      return await control.prepareAgentExecution({
        operation: "resume",
        input: { ...request.input, executionOwnerPid: process.pid, backendArgs: [...request.input.backendArgs] },
      });
    } finally {
      control.close();
    }
  };

  const attachAgentExecution = async (input: {
    agentSessionId: string;
    executionId: string;
    executionPid: number;
    executionStartedAt: string;
    executionOwnerPid?: number;
    executionOwnerStartedAt?: string;
    hostPaneId?: string;
  }): Promise<void> => {
    await withControlRecovery(async () => {
      const daemon = await ensureLocalDaemon();
      const control = await MuximodPairingControlAdapter.connect(daemon.controlSocket, {
        requestTimeoutMs: agentExecutionAttachTimeoutMs,
      });
      try {
        await control.attachAgentExecution(input);
      } finally {
        control.close();
      }
    }, ensureLocalDaemon);
  };

  const completeAgentExecution = async (
    input: Parameters<MuximodPairingControlAdapter["completeAgentExecution"]>[0],
  ) => {
    return withControlRecovery(async () => {
      const daemon = await ensureLocalDaemon();
      const control = await MuximodPairingControlAdapter.connect(daemon.controlSocket, {
        requestTimeoutMs: agentExecutionPrepareTimeoutMs,
      });
      try {
        return await control.completeAgentExecution(input);
      } finally {
        control.close();
      }
    }, ensureLocalDaemon);
  };

  const executePreparedAgent = async (
    prepared: Awaited<ReturnType<typeof prepareAgentExecution>>,
    operation: "run" | "resume",
    hostPaneId?: string,
  ) => {
    let attachError: unknown;
    let attachmentPromise: Promise<void> | undefined;
    const process = await attachedAgentExecution.execute(prepared.execution, {
      onStarted: (executionPid, executionStartedAt) => {
        attachmentPromise = attachAgentExecution({
          agentSessionId: prepared.agentSessionId,
          executionId: prepared.executionId,
          executionPid,
          executionStartedAt,
          executionOwnerPid: prepared.session.executionOwnerPid,
          executionOwnerStartedAt: prepared.session.executionOwnerStartedAt,
          ...(hostPaneId === undefined ? {} : { hostPaneId }),
        }).catch((error) => {
          attachError = error;
          logger.warn("agent.execution_attach_failed", {
            sessionId: prepared.agentSessionId,
            executionId: prepared.executionId,
            error,
          });
        });
      },
    });
    if (attachmentPromise) {
      const attachmentSettled = await Promise.race([
        attachmentPromise.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), agentExecutionAttachTimeoutMs)),
      ]);
      if (!attachmentSettled) {
        logger.warn("agent.execution_attachment_pending", {
          sessionId: prepared.agentSessionId,
          executionId: prepared.executionId,
          timeoutMs: agentExecutionAttachTimeoutMs,
        });
      }
    }
    if (attachError !== undefined) {
      logger.warn("agent.execution_running_without_daemon_attachment", {
        sessionId: prepared.agentSessionId,
        executionId: prepared.executionId,
        error: attachError,
      });
    }
    return completeAgentExecution({
      operation,
      agentSessionId: prepared.agentSessionId,
      executionId: prepared.executionId,
      ...(hostPaneId === undefined ? {} : { hostPaneId }),
      result: process,
    });
  };

  const runAgentSession = async (input: CliRunInput): Promise<RunAgentSessionResponse> => {
    const effectiveHostPaneId = hostPaneId;
    const prepared = await prepareAgentExecution({
      operation: "run",
      input: {
        ...input,
        ...(effectiveHostPaneId === undefined ? {} : { hostPaneId: effectiveHostPaneId }),
        cwd,
        backendArgs: [...input.backendArgs],
      },
    });
    const completed = await executePreparedAgent(prepared, "run", effectiveHostPaneId);
    const result: RunAgentSessionResponse = {
      process: stripExecutionPid(completed.process),
      session: completed.session,
      cleanup:
        completed.cleanup ??
        (completed.process.interrupted || completed.process.code === 130 || completed.process.code === 143
          ? { disposition: "not_requested", reason: "interrupted" }
          : completed.session.useWorktree
            ? { disposition: "retained", reason: "cleanup_declined" }
            : { disposition: "not_requested", reason: "no_worktree" }),
    };
    if (
      result.cleanup.disposition !== "retained" ||
      result.cleanup.reason !== "cleanup_declined" ||
      !result.session.useWorktree
    ) {
      return result;
    }
    if (!(await confirmCleanup(environment, result.session))) return result;
    const api = await ensureApi();
    const cleanup = await api.agentSessions.cleanup({
      workspaceScope: "current",
      force: true,
      reference: result.session.name,
    });
    return { ...result, session: cleanup.session, cleanup: cleanup.cleanup };
  };
  const cleanupAgentSession = async (input: Parameters<MuximodApiClient["agentSessions"]["cleanup"]>[0]) => {
    const api = await ensureApi();
    if (input.force) return api.agentSessions.cleanup(input);

    const session = await findAgentSession(api, input.workspaceScope, input.reference);
    if (!session?.useWorktree) return api.agentSessions.cleanup(input);
    if (!(await confirmCleanup(environment, session))) return api.agentSessions.cleanup(input);
    return api.agentSessions.cleanup({ ...input, force: true });
  };
  const input = options.input ?? process.stdin;
  const pairCommand = new PairCommand({
    io: { out: io.out, input },
    createRuntime: async ({ controlSocket, display }) => {
      const control = await MuximodPairingControlAdapter.connect(controlSocket);
      const presenter =
        display === "terminal"
          ? new TerminalPairingPresenter({ out: io.out, input })
          : new BrowserPairingPresenter({ out: io.out, input });
      return {
        useCase: new PairDevice(control, presenter),
        close: async () => {
          if (presenter instanceof BrowserPairingPresenter) await presenter.close();
          control.close();
        },
      };
    },
  });
  const systemHandlers = createSystemHandlers({
    doctor: {
      execute: async (value) =>
        runDoctor(value, {
          environment,
          logger,
          defaultRemote: runtime.codexRemote,
        }),
    },
    daemon: {
      defaults: daemonDefaults,
      start: { execute: async (input) => withApiInvalidation(() => muximod.start(input), invalidateApi) },
      status: { execute: muximod.status },
      stop: { execute: async (input) => withApiInvalidation(() => muximod.stop(input), invalidateApi) },
      restart: { execute: async (input) => withApiInvalidation(() => muximod.restart(input), invalidateApi) },
      ensure: { execute: async (input) => withApiInvalidation(() => muximod.ensure(input), invalidateApi) },
      log: {
        execute: (value) =>
          readMuximodDaemonLog({
            controlSocket: paths.controlSocket,
            lines: value.lines,
          }),
      },
    },
    serve: {
      execute: async (value): Promise<ServeResult> => {
        if (value.command === "tailscale") {
          const result = await ensureTailscaleServe(value, { logger }, environment);
          writeServeRouteState(serveStatePath, {
            schemaVersion: 1,
            ...(runtime.environmentName === undefined ? {} : { environment: runtime.environmentName }),
            component: "muximod",
            provider: "tailscale",
            hostname: result.route.hostname,
            publicUrl: result.route.publicUrl,
            localTarget: result.route.localTarget,
            externalPort: result.route.externalPort,
            path: result.route.path ?? "/",
            routeFingerprint: result.route.routeFingerprint,
            updatedAt: new Date().toISOString(),
          });
          const state = readServeRouteState(serveStatePath);
          if (!state) throw new Error(`muximod Serve state was not written: ${serveStatePath}`);
          return { command: "tailscale", result, state };
        }
        const state = readServeRouteState(serveStatePath);
        if (state && (state.environment !== runtime.environmentName || state.component !== "muximod")) {
          throw new Error(`muximod Serve state belongs to a different environment: ${serveStatePath}`);
        }
        const tailscale = createTailscaleServeClient({ environment });
        if (value.command === "status") {
          const provider = state ? await tailscale.status() : undefined;
          return {
            command: "status",
            state,
            ...(state && provider ? { routeAvailable: hasTailscaleServeRoute(provider.stdout, state) } : {}),
            ...(provider === undefined ? {} : { providerOutput: provider.stdout, providerError: provider.stderr }),
          };
        }
        if (!state) return { command: "stop", state: "already-stopped" };
        await tailscale.removeRoute(state);
        removeServeRouteState(serveStatePath);
        return { command: "stop", state: "stopped", publicUrl: state.publicUrl };
      },
    },
    io,
  });
  const pairHandler = createPairHandler({
    execute: (value) => pairCommand.execute(value),
    resolveControlSocket: () => {
      const controlSocket = paths.controlSocket;
      validateMuximodControlSocketPath(controlSocket);
      return controlSocket;
    },
    resolveMuximodBaseUrl: (value) =>
      resolvePairMuximodBaseUrl({
        withoutServe: value.withoutServe,
        environment,
        routeStateFile: serveStatePath,
      }),
  });
  const handlers: CliHandlers = {
    ...createSessionHandlers({
      run: { execute: runAgentSession },
      resume: {
        execute: async (input): Promise<ResumeAgentSessionResponse> => {
          const effectiveHostPaneId = input.hostPaneId ?? hostPaneId;
          const prepared = await prepareAgentExecution({
            operation: "resume",
            input: {
              ...input,
              ...(effectiveHostPaneId === undefined ? {} : { hostPaneId: effectiveHostPaneId }),
              backendArgs: [...input.backendArgs],
            },
          });
          const completed = await executePreparedAgent(prepared, "resume", effectiveHostPaneId);
          return { process: stripExecutionPid(completed.process), session: completed.session };
        },
      },
      cleanup: { execute: cleanupAgentSession },
      list: { execute: (input) => ensureApi().then((api) => api.agentSessions.list(input)) },
      io,
    }),
    ...createInteractiveHandlers({
      shell: shellExecutor,
      tmux: tmuxSession,
      manageSession: { execute: (input) => ensureApi().then((api) => api.sessions.manage(input)) },
      io,
    }),
    ...systemHandlers,
    pair: pairHandler,
    ...createWorkspaceHandlers({
      list: { execute: () => ensureApi().then((api) => api.workspaces.list()) },
      add: { execute: (input) => ensureApi().then((api) => api.workspaces.register(input)) },
      update: { execute: (selector, input) => ensureApi().then((api) => api.workspaces.update(selector, input)) },
      delete: { execute: (selector) => ensureApi().then((api) => api.workspaces.delete(selector)) },
      io,
    }),
  };
  const app = createCliApp({
    io,
    cwd,
    environment,
    runtime,
    handlers,
    lifecycle: {
      started: (commandPath) => logger.debug("command.started", { command: commandPath.join(" ") }),
      finished: (commandPath, status) => logger.debug("command.finished", { command: commandPath.join(" "), status }),
    },
  });

  return {
    app,
    execute: (args) => app.execute(args),
    close: () => {
      rmSync(shellHookOutputRoot, { recursive: true, force: true });
      if (!options.logger) logger.close();
    },
  };
}

async function findAgentSession(api: MuximodApiClient, workspaceScope: "current" | "all", reference: string) {
  const result = await api.agentSessions.list({ workspaceScope, includeUnavailable: true });
  const separatorIndex = reference.indexOf("/");
  const workspaceSelector = separatorIndex >= 0 ? reference.slice(0, separatorIndex) : undefined;
  const requestedName = separatorIndex >= 0 ? reference.slice(separatorIndex + 1) : reference;
  if (requestedName.includes("/")) return undefined;

  const normalizedName = normalizeSessionName(requestedName);
  const matches = result.allViews.filter((view) => {
    const session = view.session;
    const workspaceMatches =
      workspaceSelector === undefined ||
      session.workspaceId === workspaceSelector ||
      session.workspaceName === workspaceSelector;
    return workspaceMatches && (session.name === requestedName || session.name === normalizedName);
  });
  return matches.length === 1 ? matches[0]?.session : undefined;
}

function normalizeSessionName(value: string): string {
  try {
    return AgentSession.normalizeName(value);
  } catch {
    return value;
  }
}

function currentTmuxPane(environment: NodeJS.ProcessEnv): string | undefined {
  const pane = environment.TMUX && environment.TMUX_PANE ? environment.TMUX_PANE.trim() : "";
  return /^%[0-9]+$/u.test(pane) ? pane : undefined;
}

/**
 * Agent providers are interactive and receive all standard streams by
 * inheritance. Requiring every stream to be a TTY prevents a partial redirect
 * from silently changing the provider's terminal behavior.
 */
function hasInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true && process.stderr.isTTY === true;
}

function stripExecutionPid(processResult: {
  pid?: number;
  started: boolean;
  code: number;
  interrupted: boolean;
  signal?: string | null;
  failureDiagnostic?: string;
}) {
  return {
    started: processResult.started,
    code: processResult.code,
    interrupted: processResult.interrupted,
    ...(processResult.signal === undefined ? {} : { signal: processResult.signal }),
    ...(processResult.failureDiagnostic === undefined ? {} : { failureDiagnostic: processResult.failureDiagnostic }),
  };
}

async function withControlRecovery<Result>(
  operation: () => Promise<Result>,
  ensureDaemon: () => Promise<unknown>,
  attempts = 5,
): Promise<Result> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isControlConnectionError(error) || attempt + 1 >= attempts) throw error;
      await ensureDaemon();
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isControlConnectionError(error: unknown): boolean {
  if (error instanceof PairingControlError) {
    return [
      "control_socket_missing",
      "control_socket_connect_failed",
      "control_socket_connect_timeout",
      "control_socket_closed",
      "control_socket_error",
      "control_request_timeout",
    ].includes(error.code);
  }
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(String(value.code))) return true;
  if (value.cause && isControlConnectionError(value.cause)) return true;
  return false;
}

async function withApiInvalidation<Result>(operation: () => Promise<Result>, invalidate: () => void): Promise<Result> {
  try {
    return await operation();
  } finally {
    invalidate();
  }
}
