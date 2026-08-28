import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { PairDevice, RunShell } from "@muximo/application";
import { AgentSession } from "@muximo/domain";
import {
  createLogger,
  ensureTailscaleServe,
  GitShellWorktreeAdapter,
  GitWorktreeAdapter,
  type Logger,
  type LogLevel,
  localMuximodUrl,
  runDevCommand,
  runDoctor,
  type ServeCommandOptions,
  type ServeMuximodLease,
  ShellProcessAdapter,
  TmuxAdapter,
  TmuxNewSessionService,
  TmuxPanePublicationAdapter,
  WorkspaceHookAdapter,
} from "@muximo/infrastructure/cli-client";
import {
  createMuximodLifecycle,
  type MuximodLifecycle,
  resolveMuximodClientPaths,
  validateMuximodControlSocketPath,
} from "@muximo/muximod/client";
import { confirmCleanup } from "./adapters/cleanup-prompt.js";
import { BrowserPairingPresenter, PairCommand, TerminalPairingPresenter } from "./adapters/index.js";
import { connectMuximodApi, type MuximodApiClient, readMuximodDaemonLog } from "./adapters/muximod-api-client.js";
import { MuximodPairingControlAdapter } from "./adapters/muximod-pairing-control-adapter.js";
import { MuximodShellSessionWorktreeLookup, MuximodShellWorkspaceResolver } from "./adapters/muximod-shell-context.js";
import { resolvePairMuximodBaseUrl } from "./adapters/pair-route.js";
import { type CliApp, createCliApp } from "./app.js";
import type { CliHandlers, CliIo } from "./commands/types.js";
import { createInteractiveHandlers } from "./handlers/interactive.js";
import { createPairHandler } from "./handlers/pair.js";
import { createSessionHandlers } from "./handlers/session.js";
import { createSystemHandlers, type ServeResult } from "./handlers/system.js";
import { createWorkspaceHandlers } from "./handlers/workspace.js";
import { createMuximodConfigResolver } from "./muximod-config.js";

export type CliCompositionOptions = {
  includeDevelopmentCommands: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  input?: Readable;
  logger?: Logger;
  logLevel?: LogLevel;
  tmux?: TmuxAdapter;
  muximod?: MuximodLifecycle;
  muximodSchemaMode?: "migrate" | "push";
  muximodBaseInstanceDir?: string;
};

export type CliComposition = {
  app: CliApp;
  execute(args: readonly string[]): Promise<number>;
  close(): void;
};

/** The sole CLI composition root: all client and host resources are wired here. */
export function createCliComposition(options: CliCompositionOptions): CliComposition {
  const io = options.io ?? { out: process.stdout, err: process.stderr };
  const environment = { ...process.env, ...options.env };
  const cwd = options.cwd ?? process.cwd();
  const logger =
    options.logger ??
    createLogger({
      service: "muximo-cli",
      mode: "attached",
      level: options.logLevel ?? "warn",
      output: io.err,
      showStack: options.logLevel === "debug",
    });
  const paths = resolveMuximodClientPaths(environment, { baseDirectory: cwd });
  const muximod =
    options.muximod ??
    createMuximodLifecycle({
      schemaMode: options.muximodSchemaMode ?? "migrate",
      baseInstanceDir: options.muximodBaseInstanceDir,
      environment,
      resolveConfig: createMuximodConfigResolver({
        environment,
        workingDirectory: cwd,
      }),
    });
  const localDaemon = () => {
    const host = environment.MUXIMOD_HOST ?? "127.0.0.1";
    const port = readPort(environment.MUXIMOD_PORT, 4317);
    return {
      host,
      port,
      baseUrl: localMuximodUrl(host, port),
      pidFile: paths.pidFile,
      controlSocket: paths.controlSocket,
    };
  };
  let ensurePromise: Promise<void> | undefined;
  const ensureLocalDaemon = async () => {
    if (!ensurePromise) {
      ensurePromise = (async () => {
        const daemon = localDaemon();
        await muximod.ensure({
          host: daemon.host,
          port: daemon.port,
          pidFile: daemon.pidFile,
          controlSocket: daemon.controlSocket,
        });
      })().finally(() => {
        ensurePromise = undefined;
      });
    }
    await ensurePromise;
  };
  let apiPromise: Promise<MuximodApiClient> | undefined;
  const invalidateApi = () => {
    apiPromise = undefined;
  };
  const ensureApi = (): Promise<MuximodApiClient> => {
    if (!apiPromise) {
      apiPromise = (async () => {
        const daemon = localDaemon();
        await ensureLocalDaemon();
        return connectMuximodApi({
          httpBaseUrl: daemon.baseUrl,
          controlSocket: daemon.controlSocket,
          cwd,
          ensureDaemon: ensureLocalDaemon,
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
    workspace: new MuximodShellWorkspaceResolver({ cwd, environment, api: ensureApi }),
    sessions: new MuximodShellSessionWorktreeLookup(ensureApi),
    process: new ShellProcessAdapter({ environment }),
    worktrees: new GitShellWorktreeAdapter(worktrees),
    hooks,
    panes: pane,
  });
  const tmuxSession = new TmuxNewSessionService({ environment, tmux });
  const ensureMuximodForServe = async (
    serveOptions: ServeCommandOptions,
    allowedOrigins: readonly string[],
  ): Promise<ServeMuximodLease | undefined> => {
    const daemonOptions = {
      host: serveOptions.muximodHost,
      port: serveOptions.muximodPort,
      pidFile: serveOptions.pidFile ?? paths.pidFile,
      controlSocket: serveOptions.controlSocket ?? paths.controlSocket,
      muximodBaseUrl: serveOptions.muximodBaseUrl,
      logLevel: serveOptions.logLevel,
      logFile: serveOptions.logFile,
      allowedOrigins,
    };
    if (serveOptions.foreground) {
      const foregroundProcess = await muximod.startForeground(daemonOptions);
      return {
        foregroundProcess,
        cleanup: async () => {
          try {
            foregroundProcess.terminate("SIGTERM");
          } catch {
            // The process may have exited between the health check and cleanup.
          }
          await foregroundProcess.wait().catch(() => undefined);
        },
      };
    }
    const result = await muximod.ensure(daemonOptions);
    return result.state === "started" ? { cleanup: async () => void (await muximod.stop(daemonOptions)) } : undefined;
  };
  const runAgentSession = async (input: Parameters<MuximodApiClient["agentSessions"]["run"]>[0]) => {
    const api = await ensureApi();
    const result = await api.agentSessions.run(input);
    if (
      result.cleanup.disposition !== "retained" ||
      result.cleanup.reason !== "cleanup_declined" ||
      !result.session.useWorktree
    ) {
      return result;
    }
    if (!(await confirmCleanup(environment, result.session))) return result;
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
          defaultRemote: environment.MUXIMO_CODEX_REMOTE ?? "unix://",
        }),
    },
    daemon: {
      defaults: { pidFile: paths.pidFile, controlSocket: paths.controlSocket },
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
      execute: async (value): Promise<ServeResult> =>
        ensureTailscaleServe(
          value,
          {
            ensureMuximod: ensureMuximodForServe,
            logger,
          },
          environment,
        ),
    },
    dev: { execute: (value) => runDevCommand(value, environment, { logger }) },
    io,
  });
  const pairHandler = createPairHandler({
    execute: (value) => pairCommand.execute(value),
    resolveControlSocket: (value) => {
      const controlSocket = value.controlSocket ?? paths.controlSocket;
      validateMuximodControlSocketPath(controlSocket);
      return controlSocket;
    },
    resolveMuximodBaseUrl: (value) =>
      resolvePairMuximodBaseUrl(
        { withoutServe: value.withoutServe, controlSocket: value.controlSocket, environment },
        { ensureMuximod: ensureMuximodForServe, logger },
      ),
  });
  const handlers: CliHandlers = {
    ...createSessionHandlers({
      run: { execute: runAgentSession },
      resume: { execute: (input) => ensureApi().then((api) => api.agentSessions.resume(input)) },
      cleanup: { execute: cleanupAgentSession },
      list: { execute: (input) => ensureApi().then((api) => api.agentSessions.list(input)) },
      io,
    }),
    ...createInteractiveHandlers({
      shell,
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
    includeDevelopmentCommands: options.includeDevelopmentCommands,
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

function readPort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("muximod port must be between 1 and 65535");
  }
  return port;
}

async function withApiInvalidation<Result>(operation: () => Promise<Result>, invalidate: () => void): Promise<Result> {
  try {
    return await operation();
  } finally {
    invalidate();
  }
}
