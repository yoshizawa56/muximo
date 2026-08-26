import { randomBytes, randomUUID } from "node:crypto";
import {
  type AgentStatusStore,
  type ApplicationClock,
  AuthService,
  createMuximodApplication,
  DeleteWorkspace,
  ListWorkspaces,
  RegisterWorkspace,
  UpdateWorkspace,
  type WorkspaceAuditPort,
  WorkspaceRecordFactory,
} from "@muximo/application";
import {
  AuthStore,
  allowedRootsFromEnvironment,
  BunSocketAdapter,
  buildMuximoShellCommand,
  configureManagedTmuxSession,
  createAgentDatabase,
  createImagePaster,
  createLogger,
  type DatabaseSchemaSynchronizer,
  DrizzleAgentSessionRepository,
  DrizzlePaneRepository,
  DrizzleWorkspaceRepository,
  defaultPaneCleanupIntervalMs,
  defaultPaneRetentionMs,
  defaultTmuxPollIntervalMs,
  errorFields,
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
  recordAuditEvent,
  resolveMuximodPaths,
  SqliteTransactionManager,
  spawnPty,
  TmuxAdapter,
  TmuxMuximodHostAdapter,
  TmuxStateMonitor,
  TmuxViewportManager,
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
  databaseFile?: string;
  allowedRoots?: string[];
  controlSocket?: string;
  muximodBaseUrl?: string;
  /**
   * Additional exact browser origins allowed to call muximod. The bundled
   * Capacitor shell origin is always allowed. Requests without Origin remain
   * allowed for trusted local clients.
   */
  allowedOrigins?: readonly string[];
  originPolicy?: MuximodOriginPolicy;
  authSweepIntervalMs?: number;
  tmuxPollIntervalMs?: number;
  paneCleanupIntervalMs?: number;
  paneRetentionMs?: number;
  logger?: Logger;
  logLevel?: LogLevel;
  logFile?: string;
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
  const paths = resolveMuximodPaths(process.env, {
    databaseFile: options.databaseFile,
    controlSocket: options.controlSocket,
  });
  const databaseFile = paths.databaseFile;
  const configuredDatabaseFile =
    options.databaseFile ?? process.env.MUXIMOD_DB_FILE ?? process.env.MUXIMO_DATABASE_FILE;
  const usePrivateInstanceDirectory =
    Boolean(process.env.MUXIMOD_INSTANCE_DIR?.trim()) || !configuredDatabaseFile?.trim();
  const database = createAgentDatabase(databaseFile, {
    schemaSynchronizer: options.schemaSynchronizer,
    instanceDirectory:
      databaseFile === ":memory:" || !usePrivateInstanceDirectory ? undefined : paths.instanceDirectory,
  });
  const transactionManager = database.databaseFile === ":memory:" ? undefined : new SqliteTransactionManager(database);
  const agentSessionRepository = new DrizzleAgentSessionRepository(database.db);
  const paneRepository = new DrizzlePaneRepository(database.db);
  const workspaceRepository = new DrizzleWorkspaceRepository(database.db);
  const workspaceCatalog = new WorkspaceSelectionCatalog(options.allowedRoots ?? allowedRootsFromEnvironment());
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
  const application = createMuximodApplication({
    getTerminal: getLocalTerminal,
    host,
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
    agentStatus: new Map() as AgentStatusStore,
  });
  const eventHub = new MuximodEventHub();
  const hookToken = randomBytes(24).toString("hex");
  const defaultTarget = process.env.MUXIMOD_DEFAULT_TMUX_TARGET ?? "muximod";
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
    muximodBaseUrl:
      options.muximodBaseUrl ?? process.env.MUXIMOD_PAIRING_BASE_URL ?? `http://127.0.0.1:${options.port}`,
    challenges: authChallenges,
    rateLimits: authRateLimits,
    wsTickets: authWsTickets,
    connections: authenticatedConnections,
  });
  controlServer = new MuximodControlServer({
    socketPath: paths.controlSocket,
    auth,
    adoptAgentSession: (request) => application.adoptAgentSession(request),
    observeAgentSession: (request) => application.observeAgentSession(request),
    releaseAgentSession: (request) => application.releaseAgentSession(request),
  });
  let controlReady = false;
  const tmuxPollIntervalMs = durationOption(
    options.tmuxPollIntervalMs,
    "MUXIMOD_TMUX_POLL_INTERVAL_MS",
    defaultTmuxPollIntervalMs,
    1,
  );
  const paneCleanupIntervalMs = durationOption(
    options.paneCleanupIntervalMs,
    "MUXIMOD_PANE_CLEANUP_INTERVAL_MS",
    defaultPaneCleanupIntervalMs,
    1,
  );
  const paneRetentionMs = durationOption(
    options.paneRetentionMs,
    "MUXIMOD_PANE_RETENTION_MS",
    defaultPaneRetentionMs,
    0,
  );
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
        allowedOrigins: options.allowedOrigins ?? configuredOrigins(process.env.MUXIMOD_ALLOWED_ORIGINS),
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
        cwd: process.cwd(),
        defaultTarget,
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

      let createdDefaultSession = false;
      try {
        const managedSessionId = randomUUID();
        createdDefaultSession = tmux.ensureSession(
          defaultTarget,
          process.cwd(),
          buildMuximoShellCommand(undefined, {
            MUXIMOD_MANAGED_SESSION_ID: managedSessionId,
            MUXIMOD_MANAGED_SESSION_NAME: defaultTarget,
          }),
        );
        if (createdDefaultSession) configureManagedTmuxSession(tmux, defaultTarget, managedSessionId);
      } catch (error) {
        if (createdDefaultSession) {
          try {
            tmux.killSession(defaultTarget);
          } catch {
            // Preserve the warning; cleanup is best effort.
          }
        }
        logger.warn("tmux.default_session_failed", errorFields(error));
      }

      try {
        httpServer = Bun.serve({
          hostname: options.host,
          port: options.port,
          fetch: app.fetch,
          websocket: app.websocket,
        });
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

function durationOption(value: number | undefined, environmentName: string, fallback: number, minimum: number): number {
  const configured =
    value ?? (process.env[environmentName] === undefined ? fallback : Number(process.env[environmentName]));
  if (!Number.isFinite(configured) || !Number.isInteger(configured) || configured < minimum) {
    throw new Error(`${environmentName} must be an integer >= ${minimum}`);
  }
  return configured;
}

function configuredOrigins(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}
