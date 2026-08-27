import type { Readable } from "node:stream";
import {
  type AgentSessionRepository,
  manageSession,
  PairDevice,
  RunShell,
  type WorkspaceRepository,
} from "@muximo/application";
import { AgentSession } from "@muximo/domain";
import {
  type AgentDatabase,
  createAgentDatabase,
  createLogger,
  type DatabaseSchemaSynchronizer,
  DrizzleAgentSessionRepository,
  DrizzleWorkspaceRepository,
  ensureTailscaleServe,
  GitShellWorktreeAdapter,
  GitWorktreeAdapter,
  type Logger,
  type LogLevel,
  localMuximodUrl,
  readDaemonLog,
  resolveFromRoot,
  resolveMuximodPaths,
  runDevCommand,
  runDoctor,
  type ServeCommandOptions,
  type ServeProcessHandle,
  SessionWorktreeLookupAdapter,
  ShellProcessAdapter,
  SqliteTransactionManager,
  TmuxAdapter,
  TmuxMuximodHostAdapter,
  TmuxNewSessionService,
  TmuxPanePublicationAdapter,
  validateMuximodControlSocketPath,
  WorkspaceHookAdapter,
  WorkspaceResolverAdapter,
  WorkspaceSelectionCatalog,
} from "@muximo/infrastructure";
import { createMuximodLifecycle, ensureMuximodSnapshot, type MuximodLifecycle } from "@muximo/muximod";
import { confirmCleanup } from "./adapters/cleanup-prompt.js";
import { BrowserPairingPresenter, PairCommand, TerminalPairingPresenter } from "./adapters/index.js";
import { connectMuximodApi, type MuximodApiClient } from "./adapters/muximod-api-client.js";
import { MuximodPairingControlAdapter } from "./adapters/muximod-pairing-control-adapter.js";
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
  schemaSynchronizer: DatabaseSchemaSynchronizer;
  includeDevelopmentCommands: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  input?: Readable;
  logger?: Logger;
  logLevel?: LogLevel;
  databaseFile?: string;
  repositoryRoot?: string;
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

type DatabaseResources = {
  database: AgentDatabase;
  transaction: SqliteTransactionManager | undefined;
  sessions: DrizzleAgentSessionRepository;
  workspaces: DrizzleWorkspaceRepository;
  catalog: WorkspaceSelectionCatalog;
};

/** The sole CLI composition root: all concrete resources are wired here. */
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
  const paths = resolveMuximodPaths(environment, { databaseFile: options.databaseFile });
  const databaseFile = options.databaseFile ?? paths.databaseFile;
  const instanceDirectory = databaseFile === ":memory:" ? undefined : paths.instanceDirectory;
  let resources: DatabaseResources | undefined;
  const ensureDatabase = (): DatabaseResources => {
    if (resources) return resources;
    if (options.muximodSchemaMode === "push" && options.muximodBaseInstanceDir && databaseFile !== ":memory:") {
      ensureMuximodSnapshot({
        baseInstanceDir: options.muximodBaseInstanceDir,
        targetInstanceDir: paths.instanceDirectory,
        targetDatabaseFile: databaseFile,
      });
    }
    const database = createAgentDatabase(databaseFile, {
      schemaSynchronizer: options.schemaSynchronizer,
      migrationsFolder: environment.MUXIMOD_MIGRATIONS_DIR ?? environment.MUXIMO_MIGRATIONS_DIR,
      instanceDirectory,
    });
    const transaction = database.databaseFile === ":memory:" ? undefined : new SqliteTransactionManager(database);
    const sessions = new DrizzleAgentSessionRepository(database.db);
    const workspaces = new DrizzleWorkspaceRepository(database.db);
    const catalog = new WorkspaceSelectionCatalog(["/"], cwd);
    resources = {
      database,
      transaction,
      sessions,
      workspaces,
      catalog,
    };
    return resources;
  };

  const repository = (): DatabaseResources => ensureDatabase();
  const sessionRepository: AgentSessionRepository = {
    findById: (id) => repository().sessions.findById(id),
    findByName: (workspaceId, name) => repository().sessions.findByName(workspaceId, name),
    list: (workspaceId) => repository().sessions.list(workspaceId),
    insert: (record) => repository().sessions.insert(record),
    update: (record) => repository().sessions.update(record),
    claimExecution: (input) => repository().sessions.claimExecution(input),
    setBackendSessionIdIfMissing: (id, backendSessionId) =>
      repository().sessions.setBackendSessionIdIfMissing(id, backendSessionId),
    delete: (id) => repository().sessions.delete(id),
  };
  const workspaceRepository: WorkspaceRepository = {
    findById: (id) => repository().workspaces.findById(id),
    list: () => repository().workspaces.list(),
    insert: (record) => repository().workspaces.insert(record),
    upsert: (record) => repository().workspaces.upsert(record),
    delete: (id) => repository().workspaces.delete(id),
  };
  const workspace = () => new WorkspaceResolverAdapter({ cwd, environment, workspaces: workspaceRepository });
  const workspaceResolver = workspace();
  const worktrees = new GitWorktreeAdapter({
    environment,
    logger,
  });
  const hooks = new WorkspaceHookAdapter({
    environment,
    cwd,
    hookOutputRoot: resolveFromRoot(paths.hookOutputDirectory, options.repositoryRoot ?? process.cwd()),
    logger,
  });
  const tmux = options.tmux ?? new TmuxAdapter(environment.MUXIMOD_TMUX_SOCKET, undefined, environment);
  const tmuxHost = new TmuxMuximodHostAdapter(tmux, environment);
  const pane = new TmuxPanePublicationAdapter({
    environment,
    databaseFile,
    tmux,
    connect: (socketPath) => MuximodPairingControlAdapter.connect(socketPath),
    logger,
  });
  const shell = new RunShell({
    cwd,
    paneName: environment.MUXIMOD_PANE_NAME ?? environment.MUXIMOD_MANAGED_SESSION_NAME ?? "shell",
    workspace: workspaceResolver,
    sessions: new SessionWorktreeLookupAdapter({ sessions: sessionRepository }),
    process: new ShellProcessAdapter({ environment }),
    worktrees: new GitShellWorktreeAdapter(worktrees),
    hooks,
    panes: pane,
  });
  const tmuxSession = new TmuxNewSessionService({ environment, tmux });
  const muximod =
    options.muximod ??
    createMuximodLifecycle({
      schemaMode: options.muximodSchemaMode ?? "migrate",
      baseInstanceDir: options.muximodBaseInstanceDir,
      resolveConfig: createMuximodConfigResolver({
        environment,
        workingDirectory: cwd,
        databaseFile: options.databaseFile,
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
  let apiPromise: Promise<MuximodApiClient> | undefined;
  const ensureApi = (): Promise<MuximodApiClient> => {
    if (!apiPromise) {
      apiPromise = (async () => {
        const daemon = localDaemon();
        await muximod.ensure({
          host: daemon.host,
          port: daemon.port,
          pidFile: daemon.pidFile,
          controlSocket: daemon.controlSocket,
          muximodBaseUrl: daemon.baseUrl,
        });
        return connectMuximodApi({
          httpBaseUrl: daemon.baseUrl,
          controlSocket: daemon.controlSocket,
          cwd,
        });
      })().catch((error) => {
        apiPromise = undefined;
        throw error;
      });
    }
    return apiPromise;
  };
  const ensureMuximodForServe = async (
    serveOptions: ServeCommandOptions,
    allowedOrigins: readonly string[],
  ): Promise<ServeProcessHandle | undefined> => {
    const daemonOptions = {
      host: serveOptions.muximodHost,
      port: serveOptions.muximodPort,
      pidFile: serveOptions.pidFile ?? paths.pidFile,
      controlSocket: paths.controlSocket,
      muximodBaseUrl: serveOptions.muximodBaseUrl,
      logLevel: serveOptions.logLevel,
      logFile: serveOptions.logFile,
      allowedOrigins,
    };
    if (serveOptions.foreground) return muximod.startForeground(daemonOptions);
    await muximod.ensure(daemonOptions);
    return undefined;
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
          databaseFile,
          defaultRemote: environment.MUXIMO_CODEX_REMOTE ?? "unix://",
        }),
    },
    daemon: {
      defaults: { pidFile: paths.pidFile, controlSocket: paths.controlSocket },
      start: { execute: muximod.start },
      status: { execute: muximod.status },
      stop: { execute: muximod.stop },
      restart: { execute: muximod.restart },
      ensure: { execute: muximod.ensure },
      log: { execute: async (value) => readDaemonLog(value.logFile, value.lines) },
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
        { withoutServe: value.withoutServe, environment },
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
      manageSession: { execute: (input) => manageSession(input, tmuxHost) },
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
      resources?.transaction?.close();
      resources?.database.close();
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
