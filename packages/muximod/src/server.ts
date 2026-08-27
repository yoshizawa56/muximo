import { randomBytes } from "node:crypto";
import {
  type AgentObservationPort,
  type AgentStateObservation,
  type AgentStatusStore,
  type ApplicationClock,
  AuthService,
  CleanupAgentSession,
  createMuximodApplication,
  DeleteWorkspace,
  ListAgentSessions,
  ListWorkspaces,
  LocateAgentSession,
  type PanePublicationPort,
  RegisterWorkspace,
  ResumeAgentSession,
  RunAgentSession,
  UpdateWorkspace,
  type WorkspaceAuditPort,
  WorkspaceRecordFactory,
} from "@muximo/application";
import type { AgentSessionRecord } from "@muximo/domain";
import {
  AgentBackendAdapter,
  AgentSessionObservationAdapter,
  AuthStore,
  BunSocketAdapter,
  createAgentDatabase,
  createDefaultAgentBackendProviders,
  createDefaultAgentPluginRegistry,
  createImagePaster,
  createLogger,
  type DatabaseSchemaSynchronizer,
  DrizzleAgentSessionRepository,
  DrizzleCodexSessionStateRepository,
  DrizzlePaneRepository,
  DrizzleWorkspaceRepository,
  defaultPaneCleanupIntervalMs,
  defaultPaneRetentionMs,
  defaultTmuxPollIntervalMs,
  errorFields,
  GitWorktreeAdapter,
  getLocalTerminal,
  type Logger,
  type LogLevel,
  MemoryAuthChallengeStore,
  MemoryAuthenticatedConnectionRegistry,
  MemoryAuthFlowLifecycle,
  MemoryAuthRateLimitStore,
  MemoryAuthWsTicketStore,
  type MuximodSocket,
  mapTmuxSnapshotToTerminalHostSnapshot,
  nodeAuthCrypto,
  ProcessObservationAdapter,
  recordAuditEvent,
  SessionNamingAdapter,
  SqliteTransactionManager,
  spawnPty,
  TmuxAdapter,
  TmuxMuximodHostAdapter,
  TmuxStateMonitor,
  TmuxViewportManager,
  WorkspaceHookAdapter,
  WorkspaceResolverAdapter,
  WorkspaceSelectionCatalog,
} from "@muximo/infrastructure";
import { MuximodControlServer } from "./control.js";
import { MuximodEventHub } from "./events.js";
import { createMuximodApp, type MuximodApp } from "./http/app.js";
import { createOriginPolicy } from "./http/middleware.js";
import { TerminalSession, TerminalSessionRegistry } from "./http/terminal-session.js";
import type { MuximodOriginPolicy } from "./http/types.js";

export type MuximodOptions = {
  host: string;
  port: number;
  schemaSynchronizer: DatabaseSchemaSynchronizer;
  databaseFile: string;
  instanceDirectory: string;
  hookOutputDirectory: string;
  allowedRoots: readonly string[];
  controlSocket: string;
  muximodBaseUrl: string;
  /**
   * Additional exact browser origins allowed to call muximod. The bundled
   * Capacitor shell origin is always allowed. Requests without Origin remain
   * allowed for trusted local clients.
   */
  allowedOrigins: readonly string[];
  originPolicy?: MuximodOriginPolicy;
  authSweepIntervalMs?: number;
  tmuxPollIntervalMs?: number;
  paneCleanupIntervalMs?: number;
  paneRetentionMs?: number;
  logger?: Logger;
  logLevel?: LogLevel;
  logFile?: string;
  workingDirectory: string;
};

export type { MuximodApp } from "./http/app.js";
export { createMuximodApp, MuximodHttpError } from "./http/app.js";

export type MuximodServer = {
  app: MuximodApp;
  start(): Promise<void>;
  stop(): void;
};

export function createMuximodServer(options: MuximodOptions): MuximodServer {
  const ownsLogger = !options.logger;
  const logger =
    options.logger ??
    createLogger({
      service: "muximod",
      mode: options.logFile ? "background" : "attached",
      level: options.logLevel ?? "info",
      logFile: options.logFile,
      output: process.stderr,
      showStack: options.logLevel === "debug",
    });
  const tmux = new TmuxAdapter();
  const host = new TmuxMuximodHostAdapter(tmux);
  const viewportManager = new TmuxViewportManager(tmux);
  const applicationViewportManager = {
    handleTerminalHostHook: (event: Parameters<typeof viewportManager.handleTmuxHook>[0], client: string) =>
      viewportManager.handleTmuxHook(event, client),
    reassertMobileViewport: (target: string) => viewportManager.reassertMobileViewport(target),
  };
  const databaseFile = options.databaseFile;
  const database = createAgentDatabase(databaseFile, {
    schemaSynchronizer: options.schemaSynchronizer,
    instanceDirectory: databaseFile === ":memory:" ? undefined : options.instanceDirectory,
  });
  const transactionManager = database.databaseFile === ":memory:" ? undefined : new SqliteTransactionManager(database);
  const agentSessionRepository = new DrizzleAgentSessionRepository(database.db);
  const paneRepository = new DrizzlePaneRepository(database.db);
  const workspaceRepository = new DrizzleWorkspaceRepository(database.db);
  const workspaceCatalog = new WorkspaceSelectionCatalog(options.allowedRoots, options.workingDirectory);
  const clock: ApplicationClock = { now: () => new Date().toISOString() };
  const workspaceAudit: WorkspaceAuditPort = {
    record: (eventType, entityId, payload) => recordAuditEvent(database.db, { eventType, entityId, payload }),
  };
  const workspaceRecordFactory = new WorkspaceRecordFactory(workspaceCatalog, clock);
  const listWorkspaces = new ListWorkspaces(workspaceRepository);
  const registerWorkspace = new RegisterWorkspace(
    workspaceRepository,
    workspaceRecordFactory,
    workspaceAudit,
    transactionManager,
  );
  const updateWorkspace = new UpdateWorkspace(
    workspaceRepository,
    workspaceCatalog,
    workspaceRecordFactory,
    workspaceAudit,
    transactionManager,
  );
  const deleteWorkspace = new DeleteWorkspace(
    workspaceRepository,
    workspaceCatalog,
    workspaceAudit,
    transactionManager,
  );
  const agentStatus = new Map() as AgentStatusStore;
  const workspaceResolver = new WorkspaceResolverAdapter({
    cwd: options.workingDirectory,
    environment: process.env,
    workspaces: workspaceRepository,
  });
  const worktrees = new GitWorktreeAdapter({ environment: process.env, logger });
  const hooks = new WorkspaceHookAdapter({
    environment: process.env,
    cwd: options.workingDirectory,
    hookOutputRoot: options.hookOutputDirectory,
    logger,
  });
  const observations = new AgentSessionObservationAdapter({
    environment: process.env,
    resolveWorkspace: () => workspaceResolver.resolveCurrent(),
  });
  const processObservation = new ProcessObservationAdapter();
  const naming = new SessionNamingAdapter(agentSessionRepository);
  const sessionLogger = {
    child: (fields: Record<string, unknown>) => logger.child(fields),
    debug: (event: string, fields?: Record<string, unknown>) => logger.debug(event, fields),
  };
  const sessionClock = { now: () => new Date().toISOString(), id: () => randomBytes(16).toString("hex") };
  const sessionAudit = {
    record: (eventType: string, entityId: string, payload: unknown) =>
      recordAuditEvent(database.db, { eventType, entityId, payload }),
  };
  let application: ReturnType<typeof createMuximodApplication>;
  const applicationForAgentPane = () => {
    return application;
  };
  const agentPane = createAgentPanePublication(applicationForAgentPane, process.env);
  const backendOptions = {
    environment: process.env,
    plugins: createDefaultAgentPluginRegistry(),
    sessions: agentSessionRepository,
    audit: sessionAudit,
    logger,
  };
  const backend = new AgentBackendAdapter({
    ...backendOptions,
    observations: agentPane,
    providers: createDefaultAgentBackendProviders(
      backendOptions,
      new DrizzleCodexSessionStateRepository(database.db),
      process.env.MUXIMO_CODEX_REMOTE ?? "unix://",
    ),
  });
  const locator = new LocateAgentSession({ sessions: agentSessionRepository, workspace: workspaceResolver });
  const listAgentSessions = new ListAgentSessions({
    sessions: agentSessionRepository,
    host: observations,
    clock: { now: Date.now },
  });
  const runAgentSession = new RunAgentSession({
    sessions: agentSessionRepository,
    workspace: workspaceResolver,
    naming,
    hooks,
    worktrees,
    launcher: backend,
    remote: backend,
    resources: backend,
    panes: agentPane,
    audit: sessionAudit,
    clock: sessionClock,
    logger: sessionLogger,
    confirmCleanup: { confirm: async () => false },
    processId: process.pid,
  });
  const resumeAgentSession = new ResumeAgentSession({
    sessions: agentSessionRepository,
    locator,
    process: processObservation,
    launcher: backend,
    panes: agentPane,
    clock: sessionClock,
    logger: sessionLogger,
    processId: process.pid,
  });
  const cleanupAgentSession = new CleanupAgentSession({
    sessions: agentSessionRepository,
    locator,
    process: processObservation,
    worktrees,
    hooks,
    remote: backend,
    resources: backend,
    audit: sessionAudit,
    confirmCleanup: { confirm: async () => false },
    clock: sessionClock,
  });
  application = createMuximodApplication({
    agentSessions: {
      run: (input) => runAgentSession.execute(input),
      resume: (input) => resumeAgentSession.execute(input),
      cleanup: (input) => cleanupAgentSession.execute(input),
      list: (input) => listAgentSessions.execute(input),
    },
    getTerminal: getLocalTerminal,
    host,
    sessionManagement: host,
    clock,
    paneRepository,
    agentSessionRepository,
    workspaceCatalog,
    workspaceRepository,
    listWorkspaces,
    registerWorkspace,
    updateWorkspace,
    deleteWorkspace,
    viewportManager: applicationViewportManager,
    agentStatus,
  });
  const eventHub = new MuximodEventHub();
  const hookToken = randomBytes(24).toString("hex");
  const authStore = new AuthStore(database.db, database.sqlite);
  const authChallenges = new MemoryAuthChallengeStore();
  const authRateLimits = new MemoryAuthRateLimitStore();
  const authWsTickets = new MemoryAuthWsTicketStore();
  const authenticatedConnections = new MemoryAuthenticatedConnectionRegistry();
  const authFlowLifecycle = new MemoryAuthFlowLifecycle({
    challenges: authChallenges,
    rateLimits: authRateLimits,
    wsTickets: authWsTickets,
    clock: { now: () => new Date() },
    intervalMs: options.authSweepIntervalMs,
  });
  let controlServer!: MuximodControlServer;
  const auth = new AuthService({
    store: authStore,
    serverId: authStore.serverId,
    crypto: nodeAuthCrypto,
    clock: { now: () => new Date() },
    claimSink: { publish: (notification) => controlServer.notifyPairingClaim(notification) },
    muximodBaseUrl: options.muximodBaseUrl,
    challenges: authChallenges,
    rateLimits: authRateLimits,
    wsTickets: authWsTickets,
    connections: authenticatedConnections,
  });
  controlServer = new MuximodControlServer({
    socketPath: options.controlSocket,
    auth,
    adoptAgentSession: (request) => applicationForAgentPane().adoptAgentSession(request),
    observeAgentSession: (request) => applicationForAgentPane().observeAgentSession(request),
    releaseAgentSession: (request) => applicationForAgentPane().releaseAgentSession(request),
  });
  let controlReady = false;
  const tmuxPollIntervalMs = durationOption(options.tmuxPollIntervalMs, defaultTmuxPollIntervalMs, 1);
  const paneCleanupIntervalMs = durationOption(options.paneCleanupIntervalMs, defaultPaneCleanupIntervalMs, 1);
  const paneRetentionMs = durationOption(options.paneRetentionMs, defaultPaneRetentionMs, 0);
  let eventRevision = 0;
  const tmuxStateMonitor = new TmuxStateMonitor({
    readPanes: () => tmux.listPanesSnapshot(),
    synchronize: (snapshot) =>
      application.reconcile(mapTmuxSnapshotToTerminalHostSnapshot(snapshot)).then((records) => ({
        activePaneIds: records.map((record) => record.id),
        paneStates: new Map(records.map((record) => [record.hostPaneId, record.state])),
        paneRecentOutputs: new Map(records.map((record) => [record.hostPaneId, record.recentOutput])),
      })),
    cleanup: (activePaneIds, olderThan, hostServerScope) =>
      paneRepository.pruneStalePanes(activePaneIds, olderThan, hostServerScope).then(() => undefined),
    onChange: (changes) => {
      const revision = ++eventRevision;
      for (const change of changes) {
        eventHub.publish({
          type: "session_updated",
          sessionName: change.sessionName,
          reason: change.reason,
          revision,
        });
      }
    },
    intervalMs: tmuxPollIntervalMs,
    cleanupIntervalMs: paneCleanupIntervalMs,
    paneRetentionMs,
  });

  const terminalSessions = new TerminalSessionRegistry();
  const imagePaster = createImagePaster({ tmux });
  const app = createMuximodApp({
    auth,
    application,
    isReady: () => controlReady,
    originPolicy:
      options.originPolicy ??
      createOriginPolicy({
        allowedOrigins: options.allowedOrigins,
        allowNoOrigin: true,
      }),
    hookToken,
    socketFactory: (transport) => new BunSocketAdapter(transport),
    onTerminalConnection: (socket: MuximodSocket, context) => {
      authenticatedConnections.register({
        sessionId: context.sessionId,
        deviceId: context.deviceId,
        expiresAt: context.expiresAt,
        socket,
      });
      new TerminalSession(socket, {
        cwd: options.workingDirectory,
        viewportManager,
        spawnPty,
        sessions: terminalSessions,
        authDeviceId: context.deviceId,
        imagePaster: async (input) => {
          await imagePaster({ ...input, bytes: Buffer.from(input.bytes) });
        },
      });
    },
    subscribeEvents: (signal) => eventHub.subscribe(signal),
    logger,
  });
  let httpServer: ReturnType<typeof Bun.serve> | undefined;

  return {
    app,
    async start(): Promise<void> {
      if (httpServer) return;

      try {
        httpServer = Bun.serve({
          hostname: options.host,
          port: options.port,
          fetch: app.fetch,
          websocket: app.websocket,
        });
        tmux.cleanupOrphanedGroupedSessions();
        tmuxStateMonitor.start();
        viewportManager.configureHooks(`http://127.0.0.1:${httpServer.port}/internal/tmux-hook`, hookToken);
        await controlServer.start();
        controlReady = true;
        authFlowLifecycle.start();
        logger.info("daemon.listening", { host: options.host, port: httpServer.port });
      } catch (error) {
        controlReady = false;
        authFlowLifecycle.stop();
        tmuxStateMonitor.stop();
        controlServer.stop();
        httpServer?.stop(true);
        httpServer = undefined;
        const failure = error instanceof Error ? error : new Error(String(error));
        logger.error("daemon.start_failed", errorFields(failure));
        throw failure;
      }
    },
    stop() {
      controlReady = false;
      logger.info("daemon.stopping");
      authFlowLifecycle.stop();
      tmuxStateMonitor.stop();
      terminalSessions.closeAll();
      viewportManager.dispose();
      eventHub.close();
      controlServer.stop();
      httpServer?.stop(true);
      httpServer = undefined;
      transactionManager?.close();
      database.close();
      if (ownsLogger) logger.close();
    },
  };
}

function durationOption(value: number | undefined, fallback: number, minimum: number): number {
  const configured = value ?? fallback;
  if (!Number.isFinite(configured) || !Number.isInteger(configured) || configured < minimum) {
    throw new Error(`duration must be an integer >= ${minimum}`);
  }
  return configured;
}

function createAgentPanePublication(
  getApplication: () => ReturnType<typeof createMuximodApplication>,
  environment: NodeJS.ProcessEnv,
): PanePublicationPort & AgentObservationPort {
  return {
    adopt: (session) => {
      const request = agentPaneRequest(session, environment);
      return request ? getApplication().adoptAgentSession(request) : Promise.resolve();
    },
    release: (session) => {
      const request = agentPaneRequest(session, environment);
      return request ? getApplication().releaseAgentSession(request) : Promise.resolve();
    },
    publish: (session, state) => observe(session, { state }, environment, getApplication),
    observe: (session, observation) => observe(session, observation, environment, getApplication),
  };
}

function agentPaneRequest(
  session: AgentSessionRecord,
  environment: NodeJS.ProcessEnv,
): { agentSessionId: string; hostPaneId: string; executionId: string } | undefined {
  const hostPaneId = environment.TMUX_PANE?.trim();
  if (!hostPaneId || !/^%[0-9]+$/u.test(hostPaneId) || !session.executionId) return undefined;
  return { agentSessionId: session.id, hostPaneId, executionId: session.executionId };
}

function observe(
  session: AgentSessionRecord,
  observation: AgentStateObservation,
  environment: NodeJS.ProcessEnv,
  getApplication: () => ReturnType<typeof createMuximodApplication>,
): Promise<void> {
  const request = agentPaneRequest(session, environment);
  if (!request) return Promise.resolve();
  return getApplication().observeAgentSession({ ...request, ...observation });
}
