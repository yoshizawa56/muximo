import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  type AgentObservationPort,
  type AgentStateObservation,
  type AgentStatusStore,
  type ApplicationClock,
  AttachAgentSession,
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
  defaultLogFile,
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
  readDaemonLog,
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
} from "@muximo/infrastructure/runtime";
import { MuximodControlServer } from "./control.js";
import { MuximodEventHub } from "./events.js";
import { createMuximodApp, type MuximodApp } from "./http/app.js";
import { createOriginPolicy } from "./http/middleware.js";
import { TerminalSession, TerminalSessionRegistry } from "./http/terminal-session.js";
import type { MuximodOriginPolicy } from "./http/types.js";
import { type MuximodRuntimeEnvironment, minimumMuximodIntervalMs } from "./launch.js";

export type MuximodOptions = {
  host: string;
  port: number;
  configurationFingerprint: string;
  schemaSynchronizer: DatabaseSchemaSynchronizer;
  instanceDirectory: string;
  hookOutputDirectory: string;
  allowedRoots: readonly string[];
  controlSocket: string;
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
  runtimeEnvironment: MuximodRuntimeEnvironment;
  environment: NodeJS.ProcessEnv;
};

export type { MuximodApp } from "./http/app.js";
export { createMuximodApp, MuximodHttpError } from "./http/app.js";

export type MuximodServer = {
  app: MuximodApp;
  start(): Promise<void>;
  stop(): Promise<void>;
};

export function createMuximodServer(options: MuximodOptions): MuximodServer {
  const environment = resolveMuximodEnvironment(options.environment, options.runtimeEnvironment);
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
  const tmux = new TmuxAdapter(environment.MUXIMOD_TMUX_SOCKET, undefined, environment);
  const viewportManager = new TmuxViewportManager(tmux);
  const host = new TmuxMuximodHostAdapter(tmux, environment, () => viewportManager.paneLayoutOverrides());
  const applicationViewportManager = {
    handleTerminalHostHook: (event: Parameters<typeof viewportManager.handleTmuxHook>[0], client: string) =>
      viewportManager.handleTmuxHook(event, client),
    reassertMobileViewport: (target: string) => viewportManager.reassertMobileViewport(target),
  };
  const databaseFile = join(options.instanceDirectory, "muximod.sqlite");
  const database = createAgentDatabase(databaseFile, {
    schemaSynchronizer: options.schemaSynchronizer,
    environment,
    migrationsFolder: options.runtimeEnvironment.migrationsDirectory ?? undefined,
    instanceDirectory: options.instanceDirectory,
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
    environment,
    workspaces: workspaceRepository,
    directory: workspaceCatalog,
  });
  const worktrees = new GitWorktreeAdapter({ environment, logger });
  const hooks = new WorkspaceHookAdapter({
    environment,
    cwd: options.workingDirectory,
    hookOutputRoot: options.hookOutputDirectory,
    logger,
  });
  const observations = new AgentSessionObservationAdapter({
    environment,
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
  const agentPane = createAgentPanePublication(applicationForAgentPane, logger, environment);
  const backendOptions = {
    environment,
    plugins: createDefaultAgentPluginRegistry({
      opencode: {
        environment,
      },
    }),
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
      environment.MUXIMO_CODEX_REMOTE ?? "unix://",
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
    process: processObservation,
  });
  const resumeAgentSession = new ResumeAgentSession({
    sessions: agentSessionRepository,
    locator,
    process: processObservation,
    launcher: backend,
    panes: agentPane,
    clock: sessionClock,
    logger: sessionLogger,
  });
  const attachAgentSession = new AttachAgentSession({
    sessions: agentSessionRepository,
    launcher: backend,
    panes: agentPane,
    clock: sessionClock,
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
      prepareRun: (input, signal) =>
        executeAgentSession("prepare_run", input, () => runAgentSession.prepare(input, signal), logger),
      prepareResume: (input, signal) =>
        executeAgentSession("prepare_resume", input, () => resumeAgentSession.prepare(input, signal), logger),
      attach: (input) => executeAgentSession("attach", input, () => attachAgentSession.execute(input), logger),
      completeRun: (input) => executeAgentSession("complete_run", input, () => runAgentSession.complete(input), logger),
      completeResume: (input) =>
        executeAgentSession("complete_resume", input, () => resumeAgentSession.complete(input), logger),
      cleanup: (input) => executeAgentSession("cleanup", input, () => cleanupAgentSession.execute(input), logger),
      list: (input) => listAgentSessions.execute(input),
    },
    getTerminal: () => getLocalTerminal(environment),
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
    challenges: authChallenges,
    rateLimits: authRateLimits,
    wsTickets: authWsTickets,
    connections: authenticatedConnections,
  });
  controlServer = new MuximodControlServer({
    socketPath: options.controlSocket,
    auth,
    readLog: async (lines) => {
      const result = await readDaemonLog(options.logFile ?? defaultLogFile(environment), lines);
      return { ...result, lines: [...result.lines] };
    },
    adoptAgentSession: (request) => applicationForAgentPane().adoptAgentSession(request),
    observeAgentSession: (request) => applicationForAgentPane().observeAgentSession(request),
    releaseAgentSession: (request) => applicationForAgentPane().releaseAgentSession(request),
    prepareAgentExecution: async (request, signal) => {
      signal.throwIfAborted();
      const prepared =
        request.operation === "run"
          ? await application.agentSessions.prepareRun(
              {
                ...(request.input as Parameters<typeof application.agentSessions.prepareRun>[0]),
                backendArgs: [...request.input.backendArgs],
              },
              signal,
            )
          : await application.agentSessions.prepareResume(
              {
                ...(request.input as Parameters<typeof application.agentSessions.prepareResume>[0]),
                backendArgs: [...request.input.backendArgs],
              },
              signal,
            );
      signal.throwIfAborted();
      const executionId = prepared.session.executionId;
      if (executionId === undefined || executionId !== prepared.execution.executionId) {
        throw new Error("prepared agent session execution identity is incomplete");
      }
      return {
        operation: request.operation,
        agentSessionId: prepared.session.id,
        executionId,
        ...(request.input.hostPaneId === undefined ? {} : { hostPaneId: request.input.hostPaneId }),
        session: prepared.session,
        execution: prepared.execution,
      };
    },
    attachAgentExecution: async (request) => {
      await application.agentSessions.attach({
        agentSessionId: request.agentSessionId,
        executionId: request.executionId,
        executionPid: request.executionPid,
        executionStartedAt: request.executionStartedAt,
        ...(request.executionOwnerPid === undefined ? {} : { executionOwnerPid: request.executionOwnerPid }),
        ...(request.executionOwnerStartedAt === undefined
          ? {}
          : { executionOwnerStartedAt: request.executionOwnerStartedAt }),
        ...(request.hostPaneId === undefined ? {} : { hostPaneId: request.hostPaneId }),
      });
    },
    completeAgentExecution: async (request) => {
      const input = {
        agentSessionId: request.agentSessionId,
        executionId: request.executionId,
        process: request.result,
        ...(request.hostPaneId === undefined ? {} : { hostPaneId: request.hostPaneId }),
      };
      if (request.operation === "run") {
        const completed = await application.agentSessions.completeRun(input);
        return {
          operation: request.operation,
          agentSessionId: request.agentSessionId,
          executionId: request.executionId,
          process: completed.process,
          session: completed.session,
          cleanup: completed.cleanup,
        };
      }
      const completed = await application.agentSessions.completeResume(input);
      return {
        operation: request.operation,
        agentSessionId: request.agentSessionId,
        executionId: request.executionId,
        process: completed.process,
        session: completed.session,
      };
    },
  });
  let controlReady = false;
  const tmuxPollIntervalMs = durationOption(
    options.tmuxPollIntervalMs,
    defaultTmuxPollIntervalMs,
    minimumMuximodIntervalMs,
  );
  const paneCleanupIntervalMs = durationOption(
    options.paneCleanupIntervalMs,
    defaultPaneCleanupIntervalMs,
    minimumMuximodIntervalMs,
  );
  const paneRetentionMs = durationOption(
    options.paneRetentionMs,
    defaultPaneRetentionMs,
    minimumMuximodIntervalMs,
    true,
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
    heartbeat: async (snapshot) => {
      if (!snapshot.tmuxServerId || snapshot.panes.length === 0) return;
      await paneRepository.touchLastSeen(
        snapshot.tmuxServerId,
        snapshot.panes.map((pane) => pane.paneId),
        clock.now(),
      );
    },
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
    configurationFingerprint: options.configurationFingerprint,
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
        environment,
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
  let stopped = false;
  let stopPromise: Promise<void> | undefined;

  return {
    app,
    async start(): Promise<void> {
      if (stopped) throw new Error("muximod server has already stopped");
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
        await backend.restoreActiveLaunches();
        controlReady = true;
        authFlowLifecycle.start();
        logger.info("daemon.listening", { host: options.host, port: httpServer.port });
      } catch (error) {
        controlReady = false;
        try {
          authFlowLifecycle.stop();
        } catch {
          // Preserve the startup error while releasing the remaining resources.
        }
        try {
          tmuxStateMonitor.stop();
        } catch {
          // Preserve the startup error while releasing the remaining resources.
        }
        try {
          await controlServer.stop();
        } catch {
          // Preserve the startup error while releasing the remaining resources.
        }
        await backend.close().catch(() => undefined);
        try {
          await terminalSessions.closeAll();
        } catch {
          // Preserve the startup error while releasing the remaining resources.
        }
        try {
          httpServer?.stop(true);
        } catch {
          // Preserve the startup error while releasing the remaining resources.
        }
        httpServer = undefined;
        const failure = error instanceof Error ? error : new Error(String(error));
        logger.error("daemon.start_failed", errorFields(failure));
        throw failure;
      }
    },
    stop(): Promise<void> {
      if (stopPromise) return stopPromise;
      if (stopped) return Promise.resolve();
      stopped = true;
      controlReady = false;
      logger.info("daemon.stopping");
      const cleanup = async (): Promise<void> => {
        const cleanupErrors: unknown[] = [];
        try {
          authFlowLifecycle.stop();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          tmuxStateMonitor.stop();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          httpServer?.stop(true);
        } catch (error) {
          cleanupErrors.push(error);
        }
        httpServer = undefined;
        try {
          await controlServer.stop();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await backend.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          await terminalSessions.closeAll();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          viewportManager.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          eventHub.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          transactionManager?.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        try {
          database.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
        if (ownsLogger) {
          try {
            logger.close();
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        if (cleanupErrors.length === 1) throw cleanupErrors[0];
        if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "muximod cleanup failed");
      };
      stopPromise = cleanup();
      return stopPromise;
    },
  };
}

function durationOption(value: number | undefined, fallback: number, minimum: number, allowZero = false): number {
  const configured = value ?? fallback;
  const valid = (allowZero && configured === 0) || configured >= minimum;
  if (!Number.isFinite(configured) || !Number.isInteger(configured) || !valid) {
    throw new Error(`duration must be ${allowZero ? `0 or an integer >= ${minimum}` : `an integer >= ${minimum}`}`);
  }
  return configured;
}

export function resolveMuximodEnvironment(
  environment: NodeJS.ProcessEnv,
  runtime: MuximodRuntimeEnvironment,
): NodeJS.ProcessEnv {
  const resolved = { ...environment };
  setEnvironmentValue(resolved, "HOME", runtime.homeDirectory);
  setEnvironmentValue(resolved, "PATH", runtime.path);
  setEnvironmentValue(resolved, "CODEX_HOME", runtime.codexHome);
  setEnvironmentValue(resolved, "CLAUDE_CONFIG_DIR", runtime.claudeConfigDirectory);
  setEnvironmentValue(resolved, "TAILSCALE_BIN", runtime.tailscaleBinary);
  setEnvironmentValue(resolved, "TMUX_PANE", runtime.tmuxPane);
  setEnvironmentValue(resolved, "MUXIMOD_TMUX_SOCKET", runtime.tmuxSocket);
  setEnvironmentValue(resolved, "MUXIMO_WORKTREE_ID", runtime.worktreeId);
  setEnvironmentValue(resolved, "MUXIMO_WORKTREE_ROOT", runtime.worktreeRoot);
  setEnvironmentValue(resolved, "MUXIMOD_MUXIMO_COMMAND", runtime.muximoCommand);
  resolved.MUXIMO_CODEX_REMOTE = runtime.codexRemote;
  setEnvironmentValue(resolved, "MUXIMO_CODEX_BIN", runtime.codexBinary);
  setEnvironmentValue(resolved, "MUXIMO_CLAUDE_BIN", runtime.claudeBinary);
  setEnvironmentValue(resolved, "MUXIMO_OPENCODE_BIN", runtime.opencodeBinary);
  setEnvironmentValue(resolved, "MUXIMOD_MIGRATIONS_DIR", runtime.migrationsDirectory);
  return resolved;
}

function setEnvironmentValue(environment: NodeJS.ProcessEnv, key: string, value: string | null): void {
  if (value === null) delete environment[key];
  else environment[key] = value;
}

type AgentPaneApplication = Pick<
  ReturnType<typeof createMuximodApplication>,
  "adoptAgentSession" | "observeAgentSession" | "releaseAgentSession"
>;

export function createAgentPanePublication(
  getApplication: () => AgentPaneApplication,
  logger: Pick<Logger, "debug" | "warn">,
  environment: NodeJS.ProcessEnv = {},
): PanePublicationPort & AgentObservationPort {
  const paneByExecution = new Map<string, string | undefined>();
  const defaultHostPaneId = normalizeHostPaneId(environment.TMUX_PANE);
  const resolveHostPaneId = (session: AgentSessionRecord, requested?: string): string | undefined =>
    requested ?? (session.executionId ? paneByExecution.get(session.executionId) : undefined) ?? defaultHostPaneId;

  return {
    adopt: async (session, hostPaneId) => {
      const resolvedHostPaneId = resolveHostPaneId(session, hostPaneId);
      if (session.executionId) paneByExecution.set(session.executionId, resolvedHostPaneId);
      const request = agentPaneRequest(session, resolvedHostPaneId);
      if (!request) return;
      try {
        await getApplication().adoptAgentSession(request);
      } catch (error) {
        logger.warn("pane.adopt_failed", {
          pane: request.hostPaneId,
          sessionId: request.agentSessionId,
          ...errorFields(error),
        });
      }
    },
    release: async (session, hostPaneId) => {
      try {
        const request = agentPaneRequest(session, resolveHostPaneId(session, hostPaneId));
        if (!request) return;
        try {
          await getApplication().releaseAgentSession(request);
        } catch (error) {
          logger.warn("pane.release_failed", {
            pane: request.hostPaneId,
            sessionId: request.agentSessionId,
            ...errorFields(error),
          });
        }
      } finally {
        if (session.executionId) paneByExecution.delete(session.executionId);
      }
    },
    publish: (session, state, hostPaneId) =>
      observe(session, { state }, resolveHostPaneId(session, hostPaneId), getApplication, logger, "warn"),
    observe: (session, observation) =>
      observe(session, observation, resolveHostPaneId(session), getApplication, logger, "debug"),
  };
}

function agentPaneRequest(
  session: AgentSessionRecord,
  hostPaneId: string | undefined,
): { agentSessionId: string; hostPaneId: string; executionId: string } | undefined {
  const normalizedHostPaneId = hostPaneId?.trim();
  if (!normalizedHostPaneId || !/^%[0-9]+$/u.test(normalizedHostPaneId) || !session.executionId) return undefined;
  return { agentSessionId: session.id, hostPaneId: normalizedHostPaneId, executionId: session.executionId };
}

function normalizeHostPaneId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^%[0-9]+$/u.test(normalized) ? normalized : undefined;
}

function observe(
  session: AgentSessionRecord,
  observation: AgentStateObservation,
  hostPaneId: string | undefined,
  getApplication: () => AgentPaneApplication,
  logger: Pick<Logger, "debug" | "warn">,
  level: "debug" | "warn",
): Promise<void> {
  const request = agentPaneRequest(session, hostPaneId);
  if (!request) return Promise.resolve();
  return getApplication()
    .observeAgentSession({ ...request, ...observation })
    .catch((error) => {
      const fields = {
        pane: request.hostPaneId,
        sessionId: request.agentSessionId,
        state: observation.state,
        ...errorFields(error),
      };
      if (level === "warn") logger.warn("pane.publish_failed", fields);
      else logger.debug("pane.observe_failed", fields);
    });
}

async function executeAgentSession<Result>(
  operation: "prepare_run" | "prepare_resume" | "attach" | "complete_run" | "complete_resume" | "cleanup",
  input: Record<string, unknown>,
  execute: () => Promise<Result>,
  logger: Logger,
): Promise<Result> {
  try {
    return await execute();
  } catch (error) {
    logger.error(`agent_session.${operation}_failed`, {
      ...agentSessionLogFields(input),
      ...errorFields(error),
    });
    throw error;
  }
}

function agentSessionLogFields(input: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(typeof input.backend === "string" ? { backend: input.backend } : {}),
    ...(typeof input.name === "string" ? { sessionName: input.name } : {}),
    ...(typeof input.reference === "string" ? { reference: input.reference } : {}),
  };
}
