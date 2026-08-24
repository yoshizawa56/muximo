import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  CleanupAgentSession,
  DeleteWorkspace,
  EnsureDaemon,
  ListAgentSessions,
  ListWorkspaces,
  LocateAgentSession,
  type ManagedAgentSessionRepository,
  PairDevice,
  RegisterWorkspace,
  RestartDaemon,
  ResumeAgentSession,
  RunAgentSession,
  RunShell,
  StartDaemon,
  StatusDaemon,
  StopDaemon,
  UpdateWorkspace,
  WorkspaceRecordFactory,
} from "@muximo/application";
import {
  AgentBackendAdapter,
  type AgentDatabase,
  type AgentPluginRegistry,
  AgentSessionObservationAdapter,
  createAgentDatabase,
  createDefaultAgentBackendProviders,
  createDefaultAgentPluginRegistry,
  createLogger,
  DrizzleAgentSessionRepository,
  DrizzleCodexSessionStateRepository,
  DrizzleWorkspaceRepository,
  ensureTailscaleServe,
  GitShellWorktreeAdapter,
  GitWorktreeAdapter,
  type Logger,
  type LogLevel,
  MuximodDaemonProcess,
  OscTerminalTitleAdapter,
  ProcessObservationAdapter,
  recordAuditEvent,
  resolveFromRoot,
  resolveMuximodPaths,
  runDevCommand,
  runDoctor,
  SessionNamingAdapter,
  SessionWorktreeLookupAdapter,
  ShellProcessAdapter,
  SqliteTransactionManager,
  systemDaemonClock,
  systemDaemonScheduler,
  TmuxAdapter,
  TmuxNewSessionService,
  TmuxPanePublicationAdapter,
  validateMuximodControlSocketPath,
  WorkspaceHookAdapter,
  WorkspaceResolverAdapter,
  WorkspaceSelectionCatalog,
} from "@muximo/infrastructure";
import { confirmCleanup } from "./adapters/cleanup-prompt.js";
import { BrowserPairingPresenter, PairCommand, TerminalPairingPresenter } from "./adapters/index.js";
import { MuximodPairingControlAdapter } from "./adapters/muximod-pairing-control-adapter.js";
import { resolvePairMuximodBaseUrl } from "./adapters/pair-route.js";
import { type CliApp, createCliApp } from "./app.js";
import type { CliHandlers, CliIo } from "./commands/types.js";
import { createInteractiveHandlers } from "./handlers/interactive.js";
import { createPairHandler } from "./handlers/pair.js";
import { createSessionHandlers } from "./handlers/session.js";
import { createSystemHandlers, type ServeResult } from "./handlers/system.js";
import { createWorkspaceHandlers } from "./handlers/workspace.js";

export type CliCompositionOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  input?: Readable;
  logger?: Logger;
  logLevel?: LogLevel;
  databaseFile?: string;
  repositoryRoot?: string;
  tmux?: TmuxAdapter;
  agentPlugins?: AgentPluginRegistry;
  daemon?: MuximodDaemonProcess;
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
  listWorkspaces: ListWorkspaces;
  registerWorkspace: RegisterWorkspace;
  updateWorkspace: UpdateWorkspace;
  deleteWorkspace: DeleteWorkspace;
};

/** The sole CLI composition root: all concrete resources are wired here. */
export function createCliComposition(options: CliCompositionOptions = {}): CliComposition {
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
  const instanceDirectory =
    databaseFile === ":memory:" || (options.databaseFile === undefined && !environment.MUXIMOD_INSTANCE_DIR?.trim())
      ? undefined
      : paths.instanceDirectory;
  let resources: DatabaseResources | undefined;
  const ensureDatabase = (): DatabaseResources => {
    if (resources) return resources;
    const database = createAgentDatabase(databaseFile, {
      migrationsFolder: environment.MUXIMOD_MIGRATIONS_DIR ?? environment.MUXIMO_MIGRATIONS_DIR,
      instanceDirectory,
    });
    const transaction = database.databaseFile === ":memory:" ? undefined : new SqliteTransactionManager(database);
    const sessions = new DrizzleAgentSessionRepository(database.db);
    const workspaces = new DrizzleWorkspaceRepository(database.db);
    const catalog = new WorkspaceSelectionCatalog(["/"], cwd);
    const audit = {
      record: (eventType: string, entityId: string, payload: unknown) =>
        recordAuditEvent(database.db, { eventType, entityId, payload }),
    };
    const factory = new WorkspaceRecordFactory(catalog, { now: () => new Date().toISOString() });
    resources = {
      database,
      transaction,
      sessions,
      workspaces,
      catalog,
      listWorkspaces: new ListWorkspaces(workspaces),
      registerWorkspace: new RegisterWorkspace(workspaces, factory, audit, transaction),
      updateWorkspace: new UpdateWorkspace(workspaces, catalog, factory, audit, transaction),
      deleteWorkspace: new DeleteWorkspace(workspaces, catalog, audit, transaction),
    };
    return resources;
  };

  const repository = (): DatabaseResources => ensureDatabase();
  const sessionRepository: ManagedAgentSessionRepository = {
    findById: (id) => repository().sessions.findById(id),
    findByName: (workspaceId, name) => repository().sessions.findByName(workspaceId, name),
    list: (workspaceId) => repository().sessions.list(workspaceId),
    insert: (record) => repository().sessions.insert(record),
    update: (record) => repository().sessions.update(record),
    claimExecution: (input) => repository().sessions.claimExecution(input),
    delete: (id) => repository().sessions.delete(id),
  };
  const audit = {
    record: (eventType: string, entityId: string, payload: unknown) =>
      recordAuditEvent(repository().database.db, { eventType, entityId, payload }),
  };
  const sessionLogger = {
    child: (fields: Record<string, unknown>) => logger.child(fields),
    debug: (event: string, fields?: Record<string, unknown>) => logger.debug(event, fields),
  };
  const clock = { now: () => new Date().toISOString(), id: () => randomUUID() };
  const workspace = () => new WorkspaceResolverAdapter({ cwd, environment, workspaces: repository().workspaces });
  const workspaceResolver = workspace();
  const naming = new SessionNamingAdapter(sessionRepository);
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
  const pane = new TmuxPanePublicationAdapter({
    environment,
    databaseFile,
    tmux,
    connect: (socketPath) => MuximodPairingControlAdapter.connect(socketPath),
    logger,
  });
  const backendOptions = {
    environment,
    plugins: options.agentPlugins ?? createDefaultAgentPluginRegistry(),
    sessions: repository().sessions,
    audit,
    logger,
  };
  const codexState = new DrizzleCodexSessionStateRepository(repository().database.db);
  const backend = new AgentBackendAdapter({
    ...backendOptions,
    terminalTitle: new OscTerminalTitleAdapter(io.out, environment.MUXIMO_SET_TERMINAL_TITLE !== "0"),
    providers: createDefaultAgentBackendProviders(
      backendOptions,
      codexState,
      environment.MUXIMO_CODEX_REMOTE ?? "unix://",
    ),
  });
  const observations = new AgentSessionObservationAdapter({
    environment,
    resolveWorkspace: () => workspaceResolver.resolveCurrent(),
  });
  const locator = new LocateAgentSession({ sessions: sessionRepository, workspace: workspaceResolver });
  const listSessions = new ListAgentSessions({
    sessions: sessionRepository,
    host: observations,
    clock: { now: Date.now },
  });
  const runSession = new RunAgentSession({
    sessions: sessionRepository,
    workspace: workspaceResolver,
    naming,
    hooks,
    worktrees,
    launcher: backend,
    remote: backend,
    resources: backend,
    panes: pane,
    audit,
    clock,
    logger: sessionLogger,
    confirmCleanup: { confirm: (session, dirty) => confirmCleanup(environment, session, dirty) },
    processId: process.pid,
  });
  const resumeSession = new ResumeAgentSession({
    sessions: sessionRepository,
    locator,
    process: new ProcessObservationAdapter(),
    launcher: backend,
    panes: pane,
    clock,
    logger: sessionLogger,
    processId: process.pid,
  });
  const cleanupSession = new CleanupAgentSession({
    sessions: sessionRepository,
    locator,
    process: new ProcessObservationAdapter(),
    worktrees,
    hooks,
    remote: backend,
    resources: backend,
    audit,
    confirmCleanup: { confirm: (session, dirty) => confirmCleanup(environment, session, dirty) },
    clock,
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
  const daemonRuntime = options.daemon ?? new MuximodDaemonProcess({ environment });
  const daemonTiming = {
    runtime: daemonRuntime,
    clock: systemDaemonClock,
    scheduler: systemDaemonScheduler,
    lifecycleTimeoutMs: 5_000,
  };
  const ensureDaemon = new EnsureDaemon(daemonTiming);
  const startDaemon = new StartDaemon({ ...daemonTiming, ensure: ensureDaemon });
  const statusDaemon = new StatusDaemon(daemonTiming);
  const stopDaemon = new StopDaemon(daemonTiming);
  const restartDaemon = new RestartDaemon({ ...daemonTiming, stop: stopDaemon });
  const input = options.input ?? process.stdin;
  const database = repository();
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
      start: startDaemon,
      status: statusDaemon,
      stop: stopDaemon,
      restart: restartDaemon,
      ensure: ensureDaemon,
    },
    serve: {
      execute: async (value): Promise<ServeResult> =>
        ensureTailscaleServe(
          value,
          {
            ensureMuximod: async (serveOptions, allowedOrigins) => {
              await ensureDaemon.execute({
                host: serveOptions.muximodHost,
                port: serveOptions.muximodPort,
                pidFile: serveOptions.pidFile ?? paths.pidFile,
                logLevel: serveOptions.logLevel,
                logFile: serveOptions.logFile,
                allowedOrigins,
              });
            },
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
      resolvePairMuximodBaseUrl({ withoutServe: value.withoutServe, environment }, { logger }),
  });
  const handlers: CliHandlers = {
    ...createSessionHandlers({
      run: runSession,
      resume: resumeSession,
      cleanup: cleanupSession,
      list: listSessions,
      io,
    }),
    ...createInteractiveHandlers({ shell, tmux: tmuxSession, io }),
    ...systemHandlers,
    pair: pairHandler,
    ...createWorkspaceHandlers({
      list: database.listWorkspaces,
      add: database.registerWorkspace,
      update: database.updateWorkspace,
      delete: database.deleteWorkspace,
      io,
    }),
  };
  const app = createCliApp({
    io,
    cwd,
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
